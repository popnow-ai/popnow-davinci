# Manual QA: the DaVinci Resolve layer

The sign-in, prices, uploads, runs and downloads are covered by `npm test` and
`npm run test:script` against a fake PopNow. What those tests can't reach is Resolve
itself: `src/host/resolve.ts` (plugin) and `ResolveHost` in `script/PopNow.py`. Walk
through this list on a real machine before each release and save a screenshot for each
step marked 📸.

Setup: macOS or Windows, DaVinci Resolve **Studio** 19.0.2 or later for the plugin. For the
script, any edition that still runs Python scripts (see the README). A PopNow account with
at least 1,000 credits. A project with a 1080p timeline, one H.264 clip (5–8 s) on V1 and a
second clip on V2 that starts later.

## Install

1. `./install.sh` (or `.\install.ps1` as Administrator). Restart Resolve.
2. 📸 Workspace > Workflow Integrations lists **PopNow**. Workspace > Scripts lists **PopNow**.
3. Open the plugin. The window is 380 × 680, paper background; with macOS in dark mode it is
   deep plum.

## Sign-in (plugin and script share one sign-in)

4. Click **Sign in to PopNow**. The browser opens popnow.ai, sign in, approve. 📸 The tab says
   "Signed in to PopNow"; the panel shows the balance in credits.
5. `ls -l ~/Library/Application\ Support/PopNow/davinci-resolve.json` shows `-rw-------`.
6. Open the script (Workspace > Scripts > PopNow): it is already signed in and shows the same
   balance.
7. Sign out from the plugin's ⋯ menu; reopen the script: it asks to sign in.

## Clip actions (playhead parked on the V1 clip)

8. Clip tab shows the clip's name and length. Move the playhead to the V2 clip, click into
   the panel: the name updates.
9. **Edit video**: trim the V1 clip to about 3 s from the middle of a longer source. Write a
   change, click **Get price**. The source file uploads, the status shows `Cutting 3.0 s…`, then
   the button reads `Edit · 3.0 s · N credits`. Nothing is charged yet (balance unchanged). In
   popnow.ai/assets the cut is the same 3 s as the timeline (check the first and last frame).
   Repeat with a clip whose source frame rate differs from the timeline (e.g. 60 fps source on a
   24 fps timeline) and one with a speed change: the cut must still match.
9b. With an untrimmed clip (whole source on the timeline) there is no `Cutting` step.
10. Click it. Status shows progress; **Stop waiting** appears. 📸 When done, the result is in the
    media pool bin **PopNow** and on a **new video track**, starting at the clip's start.
11. **Video to audio**: result lands on a **new stereo audio track** at the clip's start, as
    long as the clip (up to 30 s).
12. **Video translator**: the button stays grey until the consent box is ticked. Tick it, run
    it; the dubbed clip lands on a new video track with its audio.
13. **Upscale** (1080p) and **Reframe** 9:16: Reframe shows `Create · Free` and runs without a
    price check.
14. Park the playhead on a gap or a generator/title clip: the panel says what to do instead.

## Frame actions

15. Park the playhead on a frame. **Edit image** exports that frame (check the temp folder for
    `frame-*.png`), uploads it, shows the price. Run it: the picture lands on a new video
    track at the playhead.
16. **Image to video**: the clip lands on a new video track at the playhead.

## Text actions

17. **Text to video**: the price appears by itself shortly after you stop typing.
18. **Music** and **Voiceover**: results land on new audio tracks at the playhead.

## Money rules

19. With an account below the price: the button is grey with **Get credits**, which opens
    popnow.ai/pricing. Nothing is charged.
20. Click **Stop waiting** during a video. The panel says PopNow keeps making it; the result
    shows up later in popnow.ai/assets and the credits are not refunded for stopping.
21. Leave a price on the button for more than 10 minutes, then click: the panel asks to check
    the price again.

## Script window

22. Studio (or free 19.0 and earlier): the script opens a small Resolve window. 📸
23. Free 19.1 to 21.0 (no UIManager): the script opens the same controls as a page on
    `http://127.0.0.1:<port>/<random>/` in the browser. Close it with **Close**.
24. Edit image, Image to video, Video to audio and the balance work as in steps 9–16.
