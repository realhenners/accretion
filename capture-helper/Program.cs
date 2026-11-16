// Native helper for Accretion. Two modes:
//
//  ScreenCapture.exe                       cursor-free screen capture (default)
//  ScreenCapture.exe --windows <pid> <file>  find, hide and restore other apps' windows (for feeding)
//
// Capture: DXGI Desktop Duplication per monitor (GPU, refresh-rate, no cursor), falling back to GDI. Both skip
// windows marked "exclude from capture" (the overlays).
// Protocol: each stdin line "x y w h" (virtual-desktop px) -> stdout: header of five int32 (x, y, w, h, n) for the
// region clamped to the desktop, then:
//   n = -1  the whole region follows: w*h*4 bytes BGRA, rows top-down
//   n =  0  nothing in the region changed since it was last sent
//   n >  0  n changed rectangles follow, each: four int32 (x, y, w, h relative to the region) then w*h*4 bytes
// Once a second it writes "STAT <total CPU ms>" to stderr. Exits when stdin closes.
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using RawRect = Vortice.RawRect;

Application.SetHighDpiMode(HighDpiMode.PerMonitorV2); // real pixels, not DPI-scaled ones
if (args.Length >= 3 && args[0] == "--windows") { WindowControl.Run(int.Parse(args[1]), args[2]); return; }

var virt = SystemInformation.VirtualScreen;
using var stdout = Console.OpenStandardOutput();
using var stdin = new StreamReader(Console.OpenStandardInput());
var hdr = new byte[20];
var rhdr = new byte[16];
var lastSent = new Dictionary<Rectangle, long[]>();   // region -> per-monitor versions we last sent for it

IFrameSource source;
try { source = new DuplicationSource(); }
catch (Exception e) { Console.Error.WriteLine($"desktop duplication unavailable ({e.Message}), using GDI"); source = new GdiSource(); }

var cpuTimer = new System.Threading.Timer(_ => {
    try { Console.Error.WriteLine($"STAT {Process.GetCurrentProcess().TotalProcessorTime.TotalMilliseconds:F0}"); } catch { }
}, null, 1000, 1000);

string? line;
while ((line = stdin.ReadLine()) != null)
{
    // "F x y w h" forces the whole region (screenshots, a window about to be swallowed).
    bool force = line.StartsWith('F');
    var p = line.TrimStart('F').Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(int.Parse).ToArray();
    if (p.Length != 4) continue;
    var r = Rectangle.Intersect(new Rectangle(p[0], p[1], p[2], p[3]), virt);
    if (r.Width <= 0 || r.Height <= 0) r = new Rectangle(virt.X, virt.Y, 1, 1);

    Update u;
    try { u = source.Get(r, force ? null : lastSent.GetValueOrDefault(r)); }
    catch (Exception e)
    {
        Console.Error.WriteLine($"capture failed ({e.Message}), switching to GDI");
        source.Dispose(); source = new GdiSource();
        lastSent.Clear();
        u = source.Get(r, null);
    }
    if (u.Rects == null || u.Rects.Count > 0) { if (lastSent.Count > 16) lastSent.Clear(); lastSent[r] = u.Versions; }

    BitConverter.TryWriteBytes(hdr.AsSpan(0, 4), r.X);
    BitConverter.TryWriteBytes(hdr.AsSpan(4, 4), r.Y);
    BitConverter.TryWriteBytes(hdr.AsSpan(8, 4), r.Width);
    BitConverter.TryWriteBytes(hdr.AsSpan(12, 4), r.Height);
    BitConverter.TryWriteBytes(hdr.AsSpan(16, 4), u.Rects == null ? -1 : u.Rects.Count);
    stdout.Write(hdr);
    if (u.Rects == null) stdout.Write(u.Full!);
    else foreach (var (rect, px) in u.Rects)
    {
        BitConverter.TryWriteBytes(rhdr.AsSpan(0, 4), rect.X - r.X);
        BitConverter.TryWriteBytes(rhdr.AsSpan(4, 4), rect.Y - r.Y);
        BitConverter.TryWriteBytes(rhdr.AsSpan(8, 4), rect.Width);
        BitConverter.TryWriteBytes(rhdr.AsSpan(12, 4), rect.Height);
        stdout.Write(rhdr);
        stdout.Write(px);
    }
    stdout.Flush();
}
cpuTimer.Dispose();
source.Dispose();

// What changed in a region: Full (everything), or a list of changed rectangles (empty = nothing changed).
record Update(long[] Versions, byte[]? Full, List<(Rectangle, byte[])>? Rects);

interface IFrameSource : IDisposable
{
    Update Get(Rectangle r, long[]? sentVersions);
}

sealed class GdiSource : IFrameSource
{
    Bitmap? bmp; Graphics? g; long version;
    public Update Get(Rectangle r, long[]? sent)   // no change tracking: always the whole region
    {
        if (bmp == null || bmp.Width != r.Width || bmp.Height != r.Height)
        {
            g?.Dispose(); bmp?.Dispose();
            bmp = new Bitmap(r.Width, r.Height, PixelFormat.Format32bppRgb);
            g = Graphics.FromImage(bmp);
        }
        g!.CopyFromScreen(r.Location, Point.Empty, r.Size, CopyPixelOperation.SourceCopy);
        var buf = new byte[r.Width * r.Height * 4];
        var d = bmp.LockBits(new Rectangle(0, 0, r.Width, r.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
        Marshal.Copy(d.Scan0, buf, 0, buf.Length); // 32bpp: stride is exactly width*4
        bmp.UnlockBits(d);
        return new Update([++version], buf, null);
    }
    public void Dispose() { g?.Dispose(); bmp?.Dispose(); }
}

// One Desktop Duplication per monitor; requests are stitched from whichever monitors they overlap, and only the
// rectangles Windows reports as changed are sent when possible.
sealed class DuplicationSource : IFrameSource
{
    readonly List<OutputDup> outputs = new();

    public DuplicationSource()
    {
        using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
        for (uint a = 0; factory.EnumAdapters1(a, out var adapter).Success; a++)
        {
            for (uint o = 0; adapter.EnumOutputs(o, out var output).Success; o++)
            {
                if (output.Description.AttachedToDesktop) outputs.Add(new OutputDup(adapter, output));
                output.Dispose();
            }
            adapter.Dispose();
        }
        if (outputs.Count == 0) throw new Exception("no monitors found");
    }

    public Update Get(Rectangle r, long[]? sent)
    {
        var versions = new long[outputs.Count];
        for (int i = 0; i < outputs.Count; i++) if (outputs[i].Bounds.IntersectsWith(r)) versions[i] = outputs[i].Poll();
        if (sent != null && sent.Length == versions.Length && sent.SequenceEqual(versions)) return new Update(versions, null, new());

        // Changed rectangles since what we last sent, if every monitor still remembers that far back.
        List<Rectangle>? dirty = sent != null && sent.Length == versions.Length ? new() : null;
        for (int i = 0; i < outputs.Count && dirty != null; i++)
        {
            if (!outputs[i].Bounds.IntersectsWith(r) || versions[i] == sent![i]) continue;
            var d = outputs[i].DirtySince(sent[i]);
            if (d == null) dirty = null; else dirty.AddRange(d);
        }
        if (dirty != null)
        {
            var rects = Merge(dirty.Select(d => Rectangle.Intersect(d, r)).Where(d => !d.IsEmpty).ToList());
            long area = rects.Sum(d => (long)d.Width * d.Height);
            if (area * 2 < (long)r.Width * r.Height)   // worth it: under half the region
            {
                var list = new List<(Rectangle, byte[])>();
                foreach (var d in rects)
                {
                    var buf = new byte[d.Width * d.Height * 4];
                    foreach (var o in outputs) if (o.Bounds.IntersectsWith(d)) o.Read(d, buf);
                    list.Add((d, buf));
                }
                return new Update(versions, null, list);
            }
        }
        var full = new byte[r.Width * r.Height * 4];
        foreach (var o in outputs) if (o.Bounds.IntersectsWith(r)) o.Read(r, full);
        return new Update(versions, full, null);
    }

    // Merge overlapping or touching rectangles so many small updates become a few bigger ones.
    static List<Rectangle> Merge(List<Rectangle> rs)
    {
        bool merged = true;
        while (merged && rs.Count > 1)
        {
            merged = false;
            for (int i = 0; i < rs.Count && !merged; i++)
                for (int j = i + 1; j < rs.Count; j++)
                {
                    var a = rs[i]; a.Inflate(8, 8);
                    if (!a.IntersectsWith(rs[j])) continue;
                    rs[i] = Rectangle.Union(rs[i], rs[j]);
                    rs.RemoveAt(j);
                    merged = true;
                    break;
                }
        }
        if (rs.Count > 24) return [rs.Aggregate(Rectangle.Union)];   // too fragmented: one bounding box
        return rs;
    }

    public void Dispose() { foreach (var o in outputs) o.Dispose(); }
}

sealed class OutputDup : IDisposable
{
    public readonly Rectangle Bounds;   // this monitor in virtual-desktop pixels
    readonly ID3D11Device device;
    readonly ID3D11DeviceContext ctx;
    readonly IDXGIOutput1 output;
    IDXGIOutputDuplication dup;
    readonly ID3D11Texture2D desktop;   // last full frame of this monitor
    ID3D11Texture2D? staging;
    bool hasFrame;
    long version;
    readonly List<(long version, Rectangle rect)> history = new();   // which areas each new frame changed
    RawRect[] dirtyBuf = new RawRect[64];
    OutduplMoveRect[] moveBuf = new OutduplMoveRect[16];

    public OutputDup(IDXGIAdapter1 adapter, IDXGIOutput output0)
    {
        var rc = output0.Description.DesktopCoordinates;
        Bounds = Rectangle.FromLTRB(rc.Left, rc.Top, rc.Right, rc.Bottom);
        D3D11.D3D11CreateDevice(adapter, DriverType.Unknown, DeviceCreationFlags.BgraSupport,
            [FeatureLevel.Level_11_0], out device!, out ctx!).CheckError();
        output = output0.QueryInterface<IDXGIOutput1>();
        dup = output.DuplicateOutput(device);
        var dd = dup.Description.ModeDescription;
        desktop = device.CreateTexture2D(new Texture2DDescription
        {
            Width = dd.Width, Height = dd.Height, MipLevels = 1, ArraySize = 1, Format = Format.B8G8R8A8_UNorm,
            SampleDescription = new SampleDescription(1, 0), Usage = ResourceUsage.Default, BindFlags = BindFlags.None,
        });
    }

    public long Poll()
    {
        // Non-blocking, except for the very first frame (the renderer paces requests).
        var res = dup.AcquireNextFrame(hasFrame ? 0u : 200u, out var info, out var resource);
        if (res.Success)
        {
            if (info.LastPresentTime != 0 || !hasFrame)   // 0 = only the mouse moved; image unchanged
            {
                var changed = hasFrame ? ChangedRects(info) : null;
                using var tex = resource.QueryInterface<ID3D11Texture2D>();
                var cursor = CopyWithoutCursor(tex);
                hasFrame = true;
                version++;
                if (changed == null) { history.Clear(); history.Add((version, Bounds)); }
                else foreach (var c in changed) history.Add((version, c));
                if (cursor is { } cb) history.Add((version, cb));   // its old spot may have been filled in
                if (history.Count > 256) history.RemoveRange(0, history.Count - 256);
            }
            resource.Dispose();
            dup.ReleaseFrame();
        }
        else if (res.Code == Vortice.DXGI.ResultCode.AccessLost.Code)
        {
            // Mode change, UAC prompt, etc.: recreate; the next poll waits for a full frame.
            dup.Dispose();
            dup = output.DuplicateOutput(device);
            hasFrame = false;
            history.Clear();
        }
        else if (res.Code != Vortice.DXGI.ResultCode.WaitTimeout.Code) res.CheckError();
        return version;
    }

    // The rectangles this frame changed (in virtual-desktop px), from Windows' own dirty and move lists.
    List<Rectangle>? ChangedRects(OutduplFrameInfo info)
    {
        if (info.TotalMetadataBufferSize == 0) return new();
        try
        {
            var list = new List<Rectangle>();
            uint need;
            var r = dup.GetFrameMoveRects((uint)(moveBuf.Length * Marshal.SizeOf<OutduplMoveRect>()), moveBuf, out need);
            if (r.Failure) return null;
            for (int i = 0; i < need / Marshal.SizeOf<OutduplMoveRect>(); i++)
            {
                var d = moveBuf[i].DestinationRect;
                list.Add(Rectangle.FromLTRB(d.Left + Bounds.X, d.Top + Bounds.Y, d.Right + Bounds.X, d.Bottom + Bounds.Y));
            }
            r = dup.GetFrameDirtyRects((uint)(dirtyBuf.Length * Marshal.SizeOf<RawRect>()), dirtyBuf, out need);
            if (r.Failure) return null;   // e.g. more rects than fit: treat the whole monitor as changed
            for (int i = 0; i < need / Marshal.SizeOf<RawRect>(); i++)
            {
                var d = dirtyBuf[i];
                list.Add(Rectangle.FromLTRB(d.Left + Bounds.X, d.Top + Bounds.Y, d.Right + Bounds.X, d.Bottom + Bounds.Y));
            }
            return list;
        }
        catch { return null; }
    }

    // Areas changed after version v (null if we no longer remember that far back).
    public List<Rectangle>? DirtySince(long v)
    {
        if (history.Count == 0 || history[0].version > v + 1) return null;
        return history.Where(h => h.version > v).Select(h => h.rect).ToList();
    }

    // Some setups draw the cursor into the desktop image (software cursor). Copy everything except the
    // cursor's box, so that spot keeps what was there before the cursor arrived.
    Rectangle? CopyWithoutCursor(ID3D11Texture2D tex)
    {
        int w = Bounds.Width, h = Bounds.Height;
        var c = hasFrame ? CursorBox.Get() : null;
        if (c is not { } cb) { ctx.CopyResource(desktop, tex); return null; }
        var local = cb; local.Offset(-Bounds.X, -Bounds.Y);
        local.Intersect(new Rectangle(0, 0, w, h));
        if (local.IsEmpty) { ctx.CopyResource(desktop, tex); return null; }
        CopyRect(tex, 0, 0, w, local.Top);                      // above
        CopyRect(tex, 0, local.Bottom, w, h);                   // below
        CopyRect(tex, 0, local.Top, local.Left, local.Bottom);  // left
        CopyRect(tex, local.Right, local.Top, w, local.Bottom); // right
        return cb;
    }

    void CopyRect(ID3D11Texture2D src, int x0, int y0, int x1, int y1)
    {
        if (x1 > x0 && y1 > y0)
            ctx.CopySubresourceRegion(desktop, 0, (uint)x0, (uint)y0, 0, src, 0, new Vortice.Mathematics.Box(x0, y0, 0, x1, y1, 1));
    }

    // Copy the part of rectangle r that lies on this monitor into buf (laid out as r, BGRA, top-down).
    public void Read(Rectangle r, byte[] buf)
    {
        if (!hasFrame) return;
        var part = Rectangle.Intersect(r, Bounds);
        if (part.IsEmpty) return;
        if (staging == null || staging.Description.Width < part.Width || staging.Description.Height < part.Height)
        {
            staging?.Dispose();
            staging = device.CreateTexture2D(new Texture2DDescription
            {
                Width = (uint)Math.Max(part.Width, 64), Height = (uint)Math.Max(part.Height, 64), MipLevels = 1, ArraySize = 1,
                Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0), Usage = ResourceUsage.Staging,
                CPUAccessFlags = CpuAccessFlags.Read, BindFlags = BindFlags.None,
            });
        }
        int lx = part.X - Bounds.X, ly = part.Y - Bounds.Y;
        ctx.CopySubresourceRegion(staging, 0, 0, 0, 0, desktop, 0,
            new Vortice.Mathematics.Box(lx, ly, 0, lx + part.Width, ly + part.Height, 1));
        var map = ctx.Map(staging, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
        try
        {
            int row = part.Width * 4, dstStride = r.Width * 4;
            int dst0 = (part.Y - r.Y) * dstStride + (part.X - r.X) * 4;
            for (int y = 0; y < part.Height; y++)
                Marshal.Copy(map.DataPointer + (nint)(y * map.RowPitch), buf, dst0 + y * dstStride, row);
        }
        finally { ctx.Unmap(staging, 0); }
    }

    public void Dispose()
    {
        staging?.Dispose(); desktop.Dispose(); dup.Dispose(); output.Dispose(); ctx.Dispose(); device.Dispose();
    }
}

// Virtual-desktop box covered by the mouse cursor right now (null if hidden), from its real shape and hotspot.
static class CursorBox
{
    const int Margin = 10;   // the frame and this query can be a moment apart while the mouse moves
    static readonly Dictionary<nint, (int hx, int hy, int w, int h)> shapes = new();

    public static Rectangle? Get()
    {
        var ci = new CURSORINFO { cbSize = Marshal.SizeOf<CURSORINFO>() };
        if (!GetCursorInfo(ref ci) || (ci.flags & 1) == 0 || ci.hCursor == 0) return null;
        if (!shapes.TryGetValue(ci.hCursor, out var s))
        {
            if (!GetIconInfo(ci.hCursor, out var ii)) return null;
            GetObject(ii.hbmMask, Marshal.SizeOf<BITMAP>(), out var bm);
            // Monochrome cursors stack AND and XOR masks in one bitmap, so it's twice as tall.
            s = (ii.xHotspot, ii.yHotspot, bm.bmWidth, ii.hbmColor == 0 ? bm.bmHeight / 2 : bm.bmHeight);
            if (ii.hbmMask != 0) DeleteObject(ii.hbmMask);
            if (ii.hbmColor != 0) DeleteObject(ii.hbmColor);
            shapes[ci.hCursor] = s;
        }
        return new Rectangle(ci.x - s.hx - Margin, ci.y - s.hy - Margin, s.w + 2 * Margin, s.h + 2 * Margin);
    }

    [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize, flags; public nint hCursor; public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public int fIcon, xHotspot, yHotspot; public nint hbmMask, hbmColor; }
    [StructLayout(LayoutKind.Sequential)] struct BITMAP { public int bmType, bmWidth, bmHeight, bmWidthBytes; public ushort bmPlanes, bmBitsPixel; public nint bmBits; }
    [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO ci);
    [DllImport("user32.dll")] static extern bool GetIconInfo(nint hIcon, out ICONINFO ii);
    [DllImport("gdi32.dll")] static extern int GetObject(nint h, int size, out BITMAP bm);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(nint h);
}

// Feeding: finds what's under a point (a window, or an icon on the desktop), hides it while it's "inside" a black
// hole, and always gives it back. Nothing is closed, moved on disk or changed: windows are only hidden, and desktop
// icons are only moved off-screen and back to exactly where they were.
// Everything hidden is also written to a file, so if this process is killed outright the next launch restores it.
// Keys: "w<hwnd>" for a window, "i<name>" for a desktop icon.
// Protocol: stdin lines; one JSON object per line on stdout.
//   AT x y      -> {"t":"at","key":"w123"|"iReadme.txt"|"","rect":[l,t,r,b],"title":"..."}
//   HIDE key    -> {"t":"hide","key":"...","ok":true|false}
//   SHOW key    -> {"t":"show","key":"..."}
//   SHOWALL     -> {"t":"showall","n":count}
// It also reports, unasked, whenever you finish dragging a window:
//   {"t":"moved","key":"w123","rect":[l,t,r,b],"x":cursorX,"y":cursorY,"title":"..."}
// and, while the left button is held, where the cursor is:
//   {"t":"mouse","down":true|false,"x":...,"y":...}
static class WindowControl
{
    static readonly Dictionary<string, (int x, int y)> hidden = new();   // key -> where an icon was (unused for windows)
    static readonly object outLock = new();
    static string stateFile = "";
    static int ownerPid;
    static WinEventProc? hook;   // kept alive: the native hook calls back into it
    static readonly string[] Shell = ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow",
                                      "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow", "TopLevelWindowForOverflowXamlIsland"];

    public static void Run(int owner, string file)
    {
        ownerPid = owner;
        stateFile = file;
        RestoreFromFile();   // anything a previous, crashed run left hidden
        AppDomain.CurrentDomain.ProcessExit += (_, _) => ShowAll();

        // Commands arrive on a background thread; the main thread runs a message loop for the window-moved hook.
        new Thread(() =>
        {
            var stdin = new StreamReader(Console.OpenStandardInput());
            string? line;
            while ((line = stdin.ReadLine()) != null)
            {
                var sp = line.IndexOf(' ');
                var cmd = sp < 0 ? line : line[..sp];
                var arg = sp < 0 ? "" : line[(sp + 1)..];
                try
                {
                    switch (cmd)
                    {
                        case "AT": { var p = arg.Split(' '); Reply(At(int.Parse(p[0]), int.Parse(p[1]))); break; }
                        case "HIDE": Reply(new { t = "hide", key = arg, ok = Hide(arg) }); break;
                        case "SHOW": Show(arg); Reply(new { t = "show", key = arg }); break;
                        case "SHOWALL": Reply(new { t = "showall", n = ShowAll() }); break;
                        case "NUDGE": { var p = arg.Split(' '); Reply(new { t = "nudge", ok = Nudge(p[0], int.Parse(p[1]), int.Parse(p[2])) }); break; }
                        case "NEAREST": { var p = arg.Split(' '); Reply(Nearest(int.Parse(p[0]), int.Parse(p[1]))); break; }
                        case "SNAP": if (arg is "on" or "off") Desktop.SetSnapping(arg == "on"); Reply(new { t = "snap", on = Desktop.Snapping() }); break;   // "Align icons to grid"
                        default: Reply(new { t = "error" }); break;
                    }
                }
                catch (Exception e) { Console.Error.WriteLine($"window command '{line}' failed: {e.Message}"); Reply(new { t = "error" }); }
            }
            ShowAll();   // the app closed or crashed: everything comes back
            Application.Exit();
        }) { IsBackground = true }.Start();

        // Watch the left mouse button: while it's held, report where the cursor goes, so the app can make a black hole
        // catchable when you drag a file (or anything else) over it.
        new Thread(() =>
        {
            bool was = false; POINT last = default;
            // The Konami code (up up down down left right left right B A). Only these six keys are looked at, and
            // only the order matters: nothing is recorded or sent anywhere except "the code was just entered".
            int[] code = [0x26, 0x26, 0x28, 0x28, 0x25, 0x27, 0x25, 0x27, 0x42, 0x41];
            int[] watched = [0x25, 0x26, 0x27, 0x28, 0x41, 0x42];
            var held = new bool[256];
            int at = 0;
            // Typing: how many keys went down in the last second. Only the count is sent, never which keys.
            var typed = new bool[256]; int presses = 0, lastSent = 0; long secondAt = Environment.TickCount64;
            string phrase = "";
            // Fullscreen: a game or video covering a whole monitor in the foreground.
            string fsWas = "";
            while (true)
            {
                for (int k = 0x08; k <= 0xDE; k++)
                {
                    if (k is 0x10 or 0x11 or 0x12 or (>= 0x14 and <= 0x1F) or (>= 0x21 and <= 0x2F) or (>= 0x5B and <= 0x8F) or (>= 0xA0 and <= 0xB9)) continue;
                    bool d = (GetAsyncKeyState(k) & 0x8000) != 0;
                    if (d && !typed[k])
                    {
                        presses++;
                        // A couple of fixed phrases, as easter eggs: letters are kept only in this short buffer, only compared
                        // with those phrases, and never sent anywhere.
                        phrase = (phrase + (k is >= 0x41 and <= 0x5A ? (char)k : k == 0x20 ? ' ' : '#'))[^Math.Min(phrase.Length + 1, 24)..];
                        foreach (var ph in Phrases) if (phrase.EndsWith(ph)) { Reply(new { t = "phrase", id = ph.ToLowerInvariant() }); phrase = ""; }
                    }
                    typed[k] = d;
                }
                if (Environment.TickCount64 - secondAt >= 1000)
                {
                    secondAt = Environment.TickCount64;
                    if (presses > 0 || lastSent > 0) Reply(new { t = "typing", n = presses });
                    lastSent = presses; presses = 0;
                    var fsNow = FullscreenApp();
                    if (fsNow != fsWas) { fsWas = fsNow; Reply(new { t = "fullscreen", rect = fsNow == "" ? null : fsNow.Split(',').Select(int.Parse).ToArray() }); }
                }
                foreach (var k in watched)
                {
                    bool d = (GetAsyncKeyState(k) & 0x8000) != 0;
                    if (d && !held[k])
                    {
                        at = k == code[at] ? at + 1 : (k == code[0] ? 1 : 0);
                        if (at == code.Length) { GetCursorPos(out var c); Reply(new { t = "konami", x = c.X, y = c.Y }); at = 0; }
                    }
                    held[k] = d;
                }
                bool down = (GetAsyncKeyState(0x01) & 0x8000) != 0;
                GetCursorPos(out var p);
                if (down != was || (down && (Math.Abs(p.X - last.X) > 3 || Math.Abs(p.Y - last.Y) > 3)))
                {
                    Reply(new { t = "mouse", down, x = p.X, y = p.Y });
                    was = down; last = p;
                }
                Thread.Sleep(30);
            }
        }) { IsBackground = true }.Start();

        _ = WatchMedia();
        hook = OnMoveSizeEnd;
        SetWinEventHook(0x000B, 0x000B, 0, hook, 0, 0, 0);   // EVENT_SYSTEM_MOVESIZEEND, out of context
        Application.Run();
    }

    static void Reply(object o) { lock (outLock) { Console.Out.WriteLine(JsonSerializer.Serialize(o)); Console.Out.Flush(); } }

    // You let go of a window you were dragging: say where, so the app can check whether you dropped it on a hole.
    static void OnMoveSizeEnd(nint hook, uint ev, nint h, int idObject, int idChild, uint thread, uint time)
    {
        if (idObject != 0 || !Swallowable(h, out var r)) return;
        GetCursorPos(out var c);
        Reply(new { t = "moved", key = "w" + (long)h, rect = new[] { r.L, r.T, r.R, r.B }, x = c.X, y = c.Y, title = Title(h) });
    }

    // The foreground window when it covers its whole monitor (and isn't the desktop or us): "l,t,r,b", else "".
    static string FullscreenApp()
    {
        var h = GetForegroundWindow();
        if (h == 0 || !IsWindowVisible(h) || IsIconic(h)) return "";
        GetWindowThreadProcessId(h, out var pid);
        if (pid == ownerPid || pid == Environment.ProcessId) return "";
        var cls = new StringBuilder(256); GetClassName(h, cls, 256);
        if (Shell.Contains(cls.ToString())) return "";
        if (!GetWindowRect(h, out var r)) return "";
        var mi = new MONITORINFO { size = Marshal.SizeOf<MONITORINFO>() };
        if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return "";
        var m = mi.monitor;
        return r.L <= m.L && r.T <= m.T && r.R >= m.R && r.B >= m.B ? $"{m.L},{m.T},{m.R},{m.B}" : "";
    }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int size; public RECT monitor, work; public int flags; }
    [DllImport("user32.dll")] static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] static extern nint MonitorFromWindow(nint h, int flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(nint m, ref MONITORINFO mi);

    static bool Swallowable(nint h, out RECT r)
    {
        r = default;
        if (!IsWindowVisible(h) || IsIconic(h)) return false;
        GetWindowThreadProcessId(h, out var pid);
        if (pid == ownerPid || pid == Environment.ProcessId) return false;
        if ((GetWindowLongPtrW(h, -20) & 0x80) != 0) return false;   // WS_EX_TOOLWINDOW
        if (DwmGetWindowAttribute(h, 14, out int cloaked, 4) == 0 && cloaked != 0) return false;   // hidden by the shell
        var cls = new StringBuilder(256); GetClassName(h, cls, 256);
        if (Shell.Contains(cls.ToString())) return false;
        if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf<RECT>()) != 0 && !GetWindowRect(h, out r)) return false;
        return r.R - r.L >= 40 && r.B - r.T >= 40;
    }
    static string Title(nint h) { var t = new StringBuilder(256); GetWindowText(h, t, 256); return t.ToString(); }

    static object At(int x, int y)
    {
        nint found = 0; RECT fr = default;
        bool covered = false;   // is a window we can't swallow (but that isn't see-through tooling) over this point?
        EnumWindows((h, _) =>
        {
            if (!IsWindowVisible(h) || IsIconic(h)) return true;
            if (DwmGetWindowAttribute(h, 14, out int cl, 4) == 0 && cl != 0) return true;
            GetWindowThreadProcessId(h, out var pid);
            if (pid == ownerPid || pid == Environment.ProcessId) return true;   // our own overlays
            if (!GetWindowRect(h, out var wr) || x < wr.L || x >= wr.R || y < wr.T || y >= wr.B) return true;
            var cls = new StringBuilder(256); GetClassName(h, cls, 256);
            if (cls.ToString() is "Progman" or "WorkerW") return false;   // reached the desktop itself
            if (!Swallowable(h, out var r))
            {
                if ((GetWindowLongPtrW(h, -20) & 0x80) == 0 && !Shell.Contains(cls.ToString())) { covered = true; return false; }
                return true;
            }
            if (x < r.L || x >= r.R || y < r.T || y >= r.B) return true;
            found = h; fr = r;
            return false;   // topmost swallowable window under the point
        }, 0);
        if (found != 0) { var fc = new StringBuilder(256); GetClassName(found, fc, 256); return new { t = "at", key = "w" + (long)found, rect = new[] { fr.L, fr.T, fr.R, fr.B }, title = Title(found), cls = fc.ToString() }; }
        if (!covered && Desktop.ItemAt(x, y) is { } icon)
            return new { t = "at", key = "i" + icon.name, rect = new[] { icon.rect.L, icon.rect.T, icon.rect.R, icon.rect.B }, title = icon.name };
        return new { t = "at", key = "", rect = new[] { 0, 0, 0, 0 }, title = "" };
    }

    static readonly string[] Phrases = ["EVENT HORIZON", "HELLO"];

    // What's playing (any app that shows in Windows' media controls). Only whether it's one particular song is sent,
    // never titles.
    static async Task WatchMedia()
    {
        try
        {
            var mgr = await Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
            string last = "";
            while (true)
            {
                string now = "";
                try
                {
                    var s = mgr.GetCurrentSession();
                    if (s != null && s.GetPlaybackInfo().PlaybackStatus == Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
                    {
                        var p = await s.TryGetMediaPropertiesAsync();
                        if ((p.Title ?? "").Contains("space oddity", StringComparison.OrdinalIgnoreCase)) now = "space oddity";
                    }
                }
                catch { }
                if (now != last) { Reply(new { t = "song", id = now }); last = now; }
                await Task.Delay(3000);
            }
        }
        catch (Exception e) { Console.Error.WriteLine($"media watch unavailable: {e.Message}"); }
    }

    // A bored black hole playing: bump a small window a few pixels (and back). Never the window you're using, a maximised
    // one, or anything big.
    static bool Nudge(string key, int dx, int dy)
    {
        if (!key.StartsWith('w') || Math.Abs(dx) > 40 || Math.Abs(dy) > 40) return false;
        var h = (nint)long.Parse(key[1..]);
        if (!IsWindow(h) || !Swallowable(h, out var r) || h == GetForegroundWindow() || IsZoomed(h)) return false;
        if (r.R - r.L > 1100 || r.B - r.T > 800) return false;
        if (!GetWindowRect(h, out var wr)) return false;
        return SetWindowPos(h, 0, wr.L + dx, wr.T + dy, 0, 0, 0x0001 | 0x0004 | 0x0010);   // no resize, no z-order change, no activation
    }
    [DllImport("user32.dll")] static extern bool IsZoomed(nint h);
    [DllImport("user32.dll")] static extern bool SetWindowPos(nint h, nint after, int x, int y, int w, int hh, uint flags);

    // The swallowable window closest to a point (for a bored black hole to drift toward).
    static object Nearest(int x, int y)
    {
        nint best = 0; RECT br = default; double bd = double.MaxValue;
        EnumWindows((h, _) =>
        {
            if (!Swallowable(h, out var r)) return true;
            double dx = Math.Max(Math.Max(r.L - x, 0), x - r.R), dy = Math.Max(Math.Max(r.T - y, 0), y - r.B);
            double d = Math.Sqrt(dx * dx + dy * dy);
            if (d < bd) { bd = d; best = h; br = r; }
            return true;
        }, 0);
        return new { t = "nearest", key = best == 0 ? "" : "w" + (long)best, rect = new[] { br.L, br.T, br.R, br.B }, title = best == 0 ? "" : Title(best) };
    }

    static bool Hide(string key)
    {
        if (hidden.ContainsKey(key)) return true;
        if (key.StartsWith('w'))
        {
            var h = (nint)long.Parse(key[1..]);
            if (!IsWindow(h) || !IsWindowVisible(h)) return false;
            ShowWindow(h, 0);   // SW_HIDE
            if (IsWindowVisible(h)) return false;   // e.g. an administrator window we're not allowed to touch
            hidden[key] = (0, 0);
        }
        else if (key.StartsWith('i'))
        {
            // With "Align icons to grid" on, Windows snaps any moved icon back onto the screen (into the first free slot,
            // top left). So snapping stays off for as long as any icon is inside a black hole, and comes back on with the
            // last one. It's recorded with the icons, so a crash puts the setting back too.
            if (!hidden.ContainsKey("snap") && Desktop.Snapping()) { Desktop.SetSnapping(false); hidden["snap"] = (1, 0); }
            if (Desktop.Park(key[1..]) is not { } was) { ResumeSnapping(); return false; }   // e.g. "Auto arrange icons" is on
            hidden[key] = was;
        }
        else return false;
        SaveFile();
        return true;
    }

    static void Show(string key)
    {
        if (!hidden.TryGetValue(key, out var was)) return;
        if (key.StartsWith('w')) { var h = (nint)long.Parse(key[1..]); if (IsWindow(h)) ShowWindow(h, 8); }   // SW_SHOWNA
        else if (key.StartsWith('i')) Desktop.Restore(key[1..], was);
        else if (key == "snap") return;   // handled once the last icon is back
        hidden.Remove(key);
        ResumeSnapping();
        SaveFile();
    }

    // Grid snapping back on once no icon is inside a black hole any more.
    static void ResumeSnapping()
    {
        if (!hidden.ContainsKey("snap") || hidden.Keys.Any(k => k.StartsWith('i'))) return;
        Desktop.SetSnapping(true);
        hidden.Remove("snap");
    }

    static int ShowAll()
    {
        int n = hidden.Count;
        foreach (var k in hidden.Keys.ToArray()) { try { Show(k); } catch { } }
        hidden.Clear();
        SaveFile();
        return n;
    }

    static void SaveFile()
    {
        try
        {
            if (hidden.Count == 0) { if (File.Exists(stateFile)) File.Delete(stateFile); }
            else File.WriteAllLines(stateFile, hidden.Select(kv => $"{kv.Key}\t{kv.Value.x}\t{kv.Value.y}"));
        }
        catch (Exception e) { Console.Error.WriteLine($"could not record hidden items: {e.Message}"); }
    }

    static void RestoreFromFile()
    {
        try
        {
            if (!File.Exists(stateFile)) return;
            int n = 0;
            foreach (var line in File.ReadAllLines(stateFile))
            {
                var p = line.Split('\t');
                if (p.Length < 3) p = [line.All(char.IsDigit) ? "w" + line : line, "0", "0"];   // older one-hwnd-per-line format
                hidden[p[0]] = (int.Parse(p[1]), int.Parse(p[2]));
                n++;
            }
            ShowAll();
            if (n > 0) Console.Error.WriteLine($"restored {n} item(s) left hidden by a previous run");
        }
        catch (Exception e) { Console.Error.WriteLine($"could not restore items from last run: {e.Message}"); }
    }

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    delegate bool EnumProc(nint h, nint l);
    delegate void WinEventProc(nint hook, uint ev, nint h, int idObject, int idChild, uint thread, uint time);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, nint l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(nint h);
    [DllImport("user32.dll")] static extern bool IsWindow(nint h);
    [DllImport("user32.dll")] static extern bool IsIconic(nint h);
    [DllImport("user32.dll")] static extern bool ShowWindow(nint h, int cmd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(nint h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint h, out int pid);
    [DllImport("user32.dll")] static extern nint GetWindowLongPtrW(nint h, int i);
    [DllImport("user32.dll")] static extern nint SetWinEventHook(uint min, uint max, nint mod, WinEventProc f, uint pid, uint thread, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(nint h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(nint h, StringBuilder s, int n);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(nint h, int attr, out int v, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(nint h, int attr, out RECT v, int size);
}

// The icons on the desktop live in a list view inside Explorer. Its items can be read and moved with list-view
// messages; the ones that take a pointer need memory inside Explorer's process, which we borrow for each call.
static class Desktop
{
    const int LVM_GETITEMCOUNT = 0x1004, LVM_GETITEMRECT = 0x100E, LVM_SETITEMPOSITION = 0x100F,
              LVM_GETITEMPOSITION = 0x1010, LVM_GETITEMTEXTW = 0x1073, LVM_SETITEMPOSITION32 = 0x1031;

    static nint ListView()
    {
        var def = FindWindowEx(FindWindow("Progman", null), 0, "SHELLDLL_DefView", null);
        if (def == 0)   // with a slideshow wallpaper the icons live under a WorkerW window instead
            EnumWindows((h, _) => { var d = FindWindowEx(h, 0, "SHELLDLL_DefView", null); if (d != 0) { def = d; return false; } return true; }, 0);
        return def != 0 ? FindWindowEx(def, 0, "SysListView32", null) : 0;
    }

    // Runs f with a scratch buffer inside Explorer's memory.
    static T WithRemote<T>(nint lv, Func<nint, nint, T> f)
    {
        GetWindowThreadProcessId(lv, out var pid);
        var proc = OpenProcess(0x0008 | 0x0010 | 0x0020 | 0x0400, false, pid);   // VM_OPERATION | VM_READ | VM_WRITE | QUERY_INFORMATION
        if (proc == 0) throw new Exception("can't open Explorer");
        var mem = VirtualAllocEx(proc, 0, 4096, 0x1000, 0x04);
        try { return f(proc, mem); }
        finally { VirtualFreeEx(proc, mem, 0, 0x8000); CloseHandle(proc); }
    }
    static byte[] Read(nint proc, nint addr, int n) { var b = new byte[n]; ReadProcessMemory(proc, addr, b, n, out _); return b; }

    static string Name(nint lv, nint proc, nint mem, int i)
    {
        // LVITEMW (64-bit): mask@0, iItem@4, iSubItem@8, state@12, stateMask@16, pszText@24, cchTextMax@32. Text at +512.
        var item = new byte[64];
        BitConverter.TryWriteBytes(item.AsSpan(4), i);
        BitConverter.TryWriteBytes(item.AsSpan(24), (long)(mem + 512));
        BitConverter.TryWriteBytes(item.AsSpan(32), 260);
        WriteProcessMemory(proc, mem, item, item.Length, out _);
        int len = (int)SendMessage(lv, LVM_GETITEMTEXTW, i, mem);
        return Encoding.Unicode.GetString(Read(proc, mem + 512, Math.Max(len, 0) * 2));
    }
    static int Find(nint lv, nint proc, nint mem, string name)
    {
        int n = (int)SendMessage(lv, LVM_GETITEMCOUNT, 0, 0);
        for (int i = 0; i < n; i++) if (Name(lv, proc, mem, i) == name) return i;
        return -1;
    }
    static (int x, int y) Pos(nint lv, nint proc, nint mem, int i)
    {
        SendMessage(lv, LVM_GETITEMPOSITION, i, mem);
        var b = Read(proc, mem, 8);
        return (BitConverter.ToInt32(b, 0), BitConverter.ToInt32(b, 4));
    }
    // Full 32-bit coordinates (the plain message packs them into 16 bits each).
    static void SetPos(nint lv, nint proc, nint mem, int i, int x, int y)
    {
        var b = new byte[8]; BitConverter.TryWriteBytes(b.AsSpan(0), x); BitConverter.TryWriteBytes(b.AsSpan(4), y);
        WriteProcessMemory(proc, mem + 256, b, 8, out _);
        SendMessage(lv, LVM_SETITEMPOSITION32, i, mem + 256);
    }

    // The icon under a screen point, with its on-screen rectangle.
    public static (string name, WindowControl.RECT rect)? ItemAt(int x, int y)
    {
        var lv = ListView();
        if (lv == 0) return null;
        return WithRemote<(string, WindowControl.RECT)?>(lv, (proc, mem) =>
        {
            var origin = new POINT(); ClientToScreen(lv, ref origin);
            int n = (int)SendMessage(lv, LVM_GETITEMCOUNT, 0, 0);
            for (int i = 0; i < n; i++)
            {
                WriteProcessMemory(proc, mem, new byte[16], 16, out _);   // left = LVIR_BOUNDS (0)
                SendMessage(lv, LVM_GETITEMRECT, i, mem);
                var b = Read(proc, mem, 16);
                var r = new WindowControl.RECT { L = BitConverter.ToInt32(b, 0) + origin.X, T = BitConverter.ToInt32(b, 4) + origin.Y,
                                                 R = BitConverter.ToInt32(b, 8) + origin.X, B = BitConverter.ToInt32(b, 12) + origin.Y };
                if (x >= r.L && x < r.R && y >= r.T && y < r.B) return (Name(lv, proc, mem, i), r);
            }
            return null;
        });
    }

    // Moves the icon off-screen; returns where it was (null if it can't be moved, e.g. "Auto arrange icons" is on).
    public static (int x, int y)? Park(string name)
    {
        var lv = ListView();
        if (lv == 0) return null;
        return WithRemote<(int, int)?>(lv, (proc, mem) =>
        {
            int i = Find(lv, proc, mem, name);
            if (i < 0) return null;
            var was = Pos(lv, proc, mem, i);
            // Somewhere no monitor shows. Explorer may clamp or snap some positions, so try a few.
            var virt = SystemInformation.VirtualScreen;
            var origin = new POINT(); ClientToScreen(lv, ref origin);
            foreach (var (tx, ty) in new[] { (-30000, -30000), (30000, 30000), (virt.Right - origin.X + 4000, virt.Bottom - origin.Y + 4000) })
            {
                SetPos(lv, proc, mem, i, tx, ty);
                var now = Pos(lv, proc, mem, i);
                if (!virt.Contains(now.x + origin.X + 10, now.y + origin.Y + 10)) return was;
            }
            long ex = SendMessage(lv, 0x1037, 0, 0);   // LVM_GETEXTENDEDLISTVIEWSTYLE
            Console.Error.WriteLine($"icon {name} would not move off-screen (desktop list style 0x{ex:X}, window style 0x{GetWindowLongPtrW(lv, -16):X}): is Auto arrange on?");
            SetPos(lv, proc, mem, i, was.x, was.y);
            return null;
        });
    }

    // "Align icons to grid" (the list view's snap-to-grid style).
    const int SNAP = 0x00080000;   // LVS_EX_SNAPTOGRID
    public static bool Snapping() { var lv = ListView(); return lv != 0 && (SendMessage(lv, 0x1037, 0, 0) & SNAP) != 0; }
    public static void SetSnapping(bool on) { var lv = ListView(); if (lv != 0) SendMessage(lv, 0x1036, SNAP, on ? SNAP : 0); }

    public static void Restore(string name, (int x, int y) was)
    {
        var lv = ListView();
        if (lv == 0) return;
        WithRemote(lv, (proc, mem) =>
        {
            int i = Find(lv, proc, mem, name);
            if (i >= 0) SetPos(lv, proc, mem, i, was.x, was.y);   // exactly where it was (a grid spot, if snapping was on)
            return 0;
        });
    }

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    delegate bool EnumProc(nint h, nint l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern nint FindWindow(string? cls, string? title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern nint FindWindowEx(nint parent, nint after, string? cls, string? title);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, nint l);
    [DllImport("user32.dll")] static extern nint SendMessage(nint h, int msg, nint w, nint l);
    [DllImport("user32.dll")] static extern bool ClientToScreen(nint h, ref POINT p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint h, out int pid);
    [DllImport("user32.dll")] static extern nint GetWindowLongPtrW(nint h, int i);
    [DllImport("kernel32.dll")] static extern nint OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(nint h);
    [DllImport("kernel32.dll")] static extern nint VirtualAllocEx(nint proc, nint addr, nint size, int type, int protect);
    [DllImport("kernel32.dll")] static extern bool VirtualFreeEx(nint proc, nint addr, nint size, int type);
    [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(nint proc, nint addr, byte[] buf, int size, out nint read);
    [DllImport("kernel32.dll")] static extern bool WriteProcessMemory(nint proc, nint addr, byte[] buf, int size, out nint written);
}
