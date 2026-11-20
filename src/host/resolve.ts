import { join } from "node:path";

/**
 * The only file that talks to DaVinci Resolve. Everything here goes through Resolve's scripting
 * object (from WorkflowIntegration.node's GetResolve()). Every call is awaited, so it works with the
 * classic synchronous API and the promise API alike. Checked by hand: docs/MANUAL-QA.md.
 */

/* Resolve's objects have no published types; keep them loose here and nowhere else. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = any;

export interface ClipInfo {
  name: string;
  /** The clip's source file on disk. */
  filePath: string;
  /** Where the clip starts on the timeline (absolute frame number). */
  recordFrame: number;
  durationFrames: number;
  fps: number;
  seconds: number;
  /** Where the used part starts inside the source file, in seconds. */
  sourceStart: number;
  /** The clip on the timeline uses the whole source file (no trim needed). */
  wholeSource: boolean;
  /** The source's shape, for the trim (so a wide clip isn't boxed into a tall frame). */
  aspect: "16:9" | "9:16" | "1:1";
}

/** "1920x1080" -> the nearest of 16:9, 9:16, 1:1. */
export function nearestAspect(resolution: string): "16:9" | "9:16" | "1:1" {
  const match = /(\d+)\s*[x×]\s*(\d+)/i.exec(resolution);
  if (!match) return "16:9";
  const ratio = Number(match[1]) / Number(match[2]);
  const options: ["16:9" | "9:16" | "1:1", number][] = [["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1]];
  return options.reduce((best, item) => (Math.abs(Math.log(ratio / item[1])) < Math.abs(Math.log(ratio / best[1])) ? item : best))[0];
}

export interface Placed {
  track: number;
  trackType: "video" | "audio";
  count: number;
}

const BIN = "PopNow";

/** "01:00:05:12" (or "01:00:05;12" drop-frame) at fps -> absolute frame number. */
export function timecodeToFrames(timecode: string, fps: number): number {
  const match = /^(\d+):(\d+):(\d+)([:;.,])(\d+)$/.exec(timecode.trim());
  if (!match) throw new TypeError(`Unexpected timecode: ${timecode}`);
  const [h, m, s, f] = [match[1], match[2], match[3], match[5]].map(Number) as [number, number, number, number];
  const base = Math.round(fps);
  const dropFrame = match[4] === ";" && (base === 30 || base === 60);
  if (!dropFrame) return ((h * 60 + m) * 60 + s) * base + f;
  // SMPTE drop-frame: skip 2 (or 4) frame numbers every minute except every tenth minute.
  const drop = base === 60 ? 4 : 2;
  const totalMinutes = h * 60 + m;
  return ((h * 60 + m) * 60 + s) * base + f - drop * (totalMinutes - Math.floor(totalMinutes / 10));
}

export class ResolveHost {
  constructor(private readonly resolve: R) {}

  private async project(): Promise<R> {
    const manager = await this.resolve.GetProjectManager();
    const project = manager ? await manager.GetCurrentProject() : undefined;
    if (!project) throw new Error("Open a project in DaVinci Resolve first.");
    return project;
  }

  private async timeline(project?: R): Promise<R> {
    const timeline = await (project ?? (await this.project())).GetCurrentTimeline();
    if (!timeline) throw new Error("Open a timeline first.");
    return timeline;
  }

  async fps(timeline?: R): Promise<number> {
    const t = timeline ?? (await this.timeline());
    const value = Number(await t.GetSetting("timelineFrameRate"));
    return Number.isFinite(value) && value > 0 ? value : 24;
  }

  async playheadFrame(timeline?: R): Promise<number> {
    const t = timeline ?? (await this.timeline());
    return timecodeToFrames(String(await t.GetCurrentTimecode()), await this.fps(t));
  }

  /**
   * The clip under the playhead on the top video track. Resolve's scripting API has no "selected
   * clips" call, so the panel works on the clip the playhead is parked on.
   */
  async currentClip(): Promise<ClipInfo> {
    const timeline = await this.timeline();
    const item = await timeline.GetCurrentVideoItem();
    if (!item) throw new Error("Park the playhead on a video clip first.");
    const poolItem = await item.GetMediaPoolItem();
    const filePath = poolItem ? String((await poolItem.GetClipProperty("File Path")) ?? "") : "";
    if (!filePath) throw new Error("This clip has no source file on disk (generated or compound clips can't be sent).");
    const fps = await this.fps(timeline);
    const durationFrames = Number(await item.GetDuration());
    // The part of the source the timeline uses: GetLeftOffset is how far the clip's head is trimmed.
    const leftOffset = Math.max(0, Number(await item.GetLeftOffset()) || 0);
    const sourceFps = Number(await poolItem.GetClipProperty("FPS")) || fps;
    const sourceFrames = Number(await poolItem.GetClipProperty("Frames")) || 0;
    const seconds = durationFrames / fps;
    const sourceSeconds = sourceFrames > 0 ? sourceFrames / sourceFps : 0;
    return {
      name: String(await item.GetName()),
      filePath,
      recordFrame: Number(await item.GetStart()),
      durationFrames,
      fps,
      seconds,
      sourceStart: leftOffset / fps,
      wholeSource: leftOffset === 0 && sourceSeconds > 0 && Math.abs(sourceSeconds - seconds) < 0.1,
      aspect: nearestAspect(String((await poolItem.GetClipProperty("Resolution")) ?? "")),
    };
  }

  /** Exports the frame under the playhead as a PNG into `folder`. */
  async exportFrame(folder: string, name: string): Promise<{ path: string; recordFrame: number }> {
    const project = await this.project();
    const timeline = await this.timeline(project);
    const path = join(folder, name);
    const ok = await project.ExportCurrentFrameAsStill(path);
    if (!ok) throw new Error("Resolve could not export the current frame. Open the Edit or Color page and try again.");
    return { path, recordFrame: await this.playheadFrame(timeline) };
  }

  private async popnowBin(pool: R): Promise<void> {
    const root = await pool.GetRootFolder();
    const folders: R[] = (await root.GetSubFolderList()) ?? [];
    let bin: R;
    for (const folder of Object.values(folders)) {
      if ((await folder.GetName()) === BIN) bin = folder;
    }
    bin ??= await pool.AddSubFolder(root, BIN);
    if (bin) await pool.SetCurrentFolder(bin);
  }

  /**
   * Imports the files into the media pool (PopNow bin) and puts them on a new track at
   * `recordFrame`: video and pictures on a new video track, audio on a new stereo audio track.
   */
  async place(paths: readonly string[], kind: "video" | "audio" | "image", recordFrame: number): Promise<Placed> {
    const project = await this.project();
    const timeline = await this.timeline(project);
    const pool = await project.GetMediaPool();
    await this.popnowBin(pool);
    const items: R[] = Object.values((await pool.ImportMedia([...paths])) ?? {});
    if (items.length === 0) throw new Error("Resolve could not import the result. It is saved here: " + paths.join(", "));
    const trackType = kind === "audio" ? "audio" : "video";
    const added = trackType === "audio" ? await timeline.AddTrack("audio", "stereo") : await timeline.AddTrack("video");
    if (!added) throw new Error("Resolve could not add a new track.");
    const track = Number(await timeline.GetTrackCount(trackType));
    let at = recordFrame;
    const infos: Record<string, unknown>[] = [];
    for (const item of items) {
      const frames = Number(await item.GetClipProperty("Frames"));
      const info: Record<string, unknown> = { mediaPoolItem: item, trackIndex: track, recordFrame: at };
      if (Number.isFinite(frames) && frames > 0) {
        info.startFrame = 0;
        info.endFrame = frames - 1;
        at += frames;
      }
      if (trackType === "audio") info.mediaType = 2;
      infos.push(info);
    }
    const appended = await pool.AppendToTimeline(infos);
    const count = Object.values(appended ?? {}).length;
    if (count === 0) throw new Error("The result is in the PopNow bin, but Resolve could not put it on the timeline.");
    return { track, trackType, count };
  }
}
