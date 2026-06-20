import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { parsePatchFiles, type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { HostContext, ToolResultCard } from "./card-types.js";

type ThemeType = "light" | "dark";

interface PayloadRendererOptions {
  card: ToolResultCard;
  hostContext?: HostContext;
  errorMessage?: string | null;
  visibleFileCount?: number;
  initialOpenPath?: string;
}

interface MountedPayload {
  update(options: PayloadRendererOptions): void;
  unmount(): void;
}

export function mountReviewPayload(
  container: HTMLElement,
  options: PayloadRendererOptions,
): MountedPayload {
  const root = createRoot(container);
  root.render(<ReviewPayload {...options} />);

  return {
    update(nextOptions) {
      root.render(<ReviewPayload {...nextOptions} />);
    },
    unmount() {
      root.unmount();
    },
  };
}

function ReviewPayload({
  card,
  hostContext,
  errorMessage = null,
  visibleFileCount,
  initialOpenPath,
}: PayloadRendererOptions) {
  const [loadedPatch, setLoadedPatch] = useState<string | null>(card.payload?.patch ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const patch = card.payload?.patch ?? loadedPatch ?? undefined;
  const themeType: ThemeType = hostContext?.theme === "light" ? "light" : "dark";
  const files = useMemo(() => parseFiles(patch), [patch]);
  const visibleFiles = typeof visibleFileCount === "number"
    ? files.slice(0, visibleFileCount)
    : files;
  const initialOpenKey = useMemo(
    () => findFileKeyByPath(files, initialOpenPath),
    [files, initialOpenPath],
  );
  const [openFiles, setOpenFiles] = useState(() =>
    initialOpenKey ? new Set<string>([initialOpenKey]) : new Set<string>(),
  );

  useEffect(() => {
    if (card.payload?.patch || !card.payload?.reviewPayloadUrl) return;
    let cancelled = false;
    setLoadedPatch(null);
    setLoadError(null);
    fetch(card.payload.reviewPayloadUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Diff request failed with ${response.status}`);
        const body = await response.json() as { patch?: unknown };
        if (typeof body.patch !== "string") throw new Error("Diff response did not include a patch.");
        if (!cancelled) setLoadedPatch(body.patch);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [card.payload?.patch, card.payload?.reviewPayloadUrl]);

  useEffect(() => {
    if (!initialOpenKey) return;
    setOpenFiles((current) => {
      if (current.has(initialOpenKey)) return current;
      const next = new Set(current);
      next.add(initialOpenKey);
      return next;
    });
  }, [initialOpenKey]);

  if (errorMessage) return <StatusLine message={errorMessage} tone="error" />;
  if (loadError) return <StatusLine message={loadError} tone="error" />;
  if (!patch && card.payload?.reviewPayloadUrl) return <StatusLine message="Loading diff..." />;
  if (!patch) return <StatusLine message="Diff payload is not available." />;
  if (files.length === 0) return <StatusLine message="No diff hunks to review." />;

  const options = diffOptions(themeType);

  return (
    <div className="review-diff">
      <div className="review-diff-files">
        {visibleFiles.map((fileDiff, index) => {
          const key = fileKey(fileDiff, index);
          const stats = diffStats(fileDiff);
          const isOpen = openFiles.has(key);

          return (
            <div className="review-diff-file" key={key}>
              <button
                type="button"
                className="review-diff-file-header"
                aria-expanded={isOpen}
                onClick={() => {
                  const next = new Set(openFiles);
                  if (next.has(key)) {
                    next.delete(key);
                  } else {
                    next.add(key);
                  }
                  setOpenFiles(next);
                }}
              >
                <span className="review-diff-file-name">{fileDiff.name}</span>
                <span className="review-diff-file-stats">
                  <span className="add">+{stats.additions}</span>
                  <span className="remove">-{stats.removals}</span>
                </span>
              </button>
              {isOpen ? (
                <FileDiff fileDiff={fileDiff} options={options} className="pierre-diff" />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function parseFiles(patch: string | undefined): FileDiffMetadata[] {
  if (!patch) return [];
  return parsePatchFiles(patch, "review", true).flatMap((parsedPatch) => parsedPatch.files);
}

function findFileKeyByPath(
  files: FileDiffMetadata[],
  path: string | undefined,
): string | null {
  if (!path) return null;

  const index = files.findIndex((file) =>
    file.name === path ||
    file.prevName === path ||
    file.name.endsWith(`/${path}`) ||
    path.endsWith(`/${file.name}`),
  );

  return index >= 0 ? fileKey(files[index], index) : null;
}

function fileKey(fileDiff: FileDiffMetadata, index: number): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? ""}->${fileDiff.name}-${index}`;
}

function diffStats(fileDiff: FileDiffMetadata): { additions: number; removals: number } {
  return fileDiff.hunks.reduce(
    (stats, hunk) => ({
      additions: stats.additions + hunk.additionLines,
      removals: stats.removals + hunk.deletionLines,
    }),
    { additions: 0, removals: 0 },
  );
}

function diffOptions(themeType: ThemeType): FileDiffOptions<undefined> {
  return {
    theme: {
      light: "pierre-light",
      dark: "pierre-dark",
    },
    themeType,
    diffStyle: "unified",
    diffIndicators: "bars",
    hunkSeparators: "line-info",
    lineDiffType: "word-alt",
    overflow: "scroll",
    collapsedContextThreshold: 4,
    expansionLineCount: 20,
    stickyHeader: false,
    disableFileHeader: true,
  };
}

function StatusLine({
  message,
  tone = "muted",
}: {
  message: string;
  tone?: "muted" | "error";
}) {
  return <div className={`status ${tone}`}>{message}</div>;
}
