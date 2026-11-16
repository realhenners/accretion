# Privacy

Accretion is a desktop pet that bends the picture of your screen. To do that it has to look at your screen, and a few of
its features listen or watch for things. This page lists every one of them, what it's for, and where the data goes.

**Short version:** everything stays on your PC. Nothing is uploaded, collected or shared, with one exception you
control: checking GitHub for updates (see the last section).

## What it reads, and why

| What | Why | Where it goes |
| --- | --- | --- |
| **Your screen, around each black hole** | To draw the bent desktop behind it. | Only into memory, to draw the next frame. Never saved or sent. Accretion's own windows are left out of the picture. |
| **A picture of a window or file you feed it** | So the picture can fall in, and be spat back out. | Kept in memory until it's spat out. The biggest thing each hole eats is kept as a tiny picture (128×80) on your PC, so it can "dream" about it. |
| **How many keys you press per second** | So it keeps still and quiet while you type. | Only the count is used. Which keys you press is never recorded or sent anywhere. |
| **Two typed phrases** ("event horizon", "hello") | Easter eggs. | The helper keeps only the last few letters typed, in memory, compares them with those two phrases, and never sends them anywhere. |
| **The sound your PC is playing** (optional) | So black holes can dance to music. | Analysed live for the beat. Never recorded, saved or sent. Off with Settings → Sound → *Dance to music on the PC*. |
| **Whether one particular song is playing** | An easter egg. | Windows' media controls are asked what's playing; only "is it that song or not" is used. Titles are never stored or sent. |
| **The window under a black hole, and its title** | To know what it's being fed, and to name trophies. | Used in the moment; titles of things it ate appear in its trophy shelf and journal on your PC. |
| **Your cursor position** | Leaning toward you, petting, drawing paths. | Used in the moment only. |
| **A picture of another monitor** (only with the Wormhole look) | To show through the shadow. | Used in the moment only. |
| **Pictures dragged from a web page** | To eat them. | Accretion downloads that one picture (once, when you drop it), from the address the page gave. |

## What it saves on your PC

All in `%APPDATA%\Accretion`:

- `settings.json`: your settings, your black holes (names, ages, what they've done), achievements and the journal.
- `memories\`: the tiny dream pictures.
- `gallery\`: one portrait of each black hole a day.
- `logs\`: a log of what the app did, for troubleshooting.
- `crash-reports\`: if something goes wrong, a report is saved here. These are never uploaded.
- `plugins\`: your own looks and food rules, if you add any.

Delete that folder to remove everything. Uninstalling leaves it in place, so your pets survive a reinstall.

## What it never does

- It never closes, deletes, moves or changes your windows or files. Eating is visual: windows are hidden and come back
  when they're spat out (and always when Accretion closes, even if it crashes). It does nudge small windows a few
  pixels and back when it's bored, if *Play with windows* is on.
- It doesn't send analytics, telemetry or crash reports, and there's no account.

## The one thing that goes online: updates

When Accretion is installed (not when run from source), it checks this project's GitHub Releases for a newer version
a short while after it starts and then every few hours. That's an ordinary request to GitHub, which, like any web
server, sees your IP address. If an update is there, it's downloaded and installed the next time you quit. Turn it
off in Settings → System → *Check for updates automatically*.

Share codes and share cards are made on your PC and only go where you put them.
