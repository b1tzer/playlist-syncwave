import { useState, type ReactNode } from "react";
import type { PendingConfirmSession } from "@core/models/sync";
import { createRendererLogger } from "../logging/rendererLogger";
import { useI18n } from "../i18n";
import { formatDuration } from "../sync/helpers";

const log = createRendererLogger("renderer.confirm-dialog");

/**
 * 候选版本展示模板：弹窗渲染所需的固定参数（字段缺省为空，模板不变）。
 * 数据来源为平台搜索结果的 PlatformSong，映射至此结构。
 */
export interface CandidateDisplayTemplate {
  /** 候选歌曲 ID */
  id: string;
  /** 候选歌名 */
  title: string;
  /** 候选歌手 */
  artist: string;
  /** 所属专辑（可为空） */
  album?: string;
  /** 封面图 URL（可为空，空则显示占位图标） */
  coverUrl?: string;
  /** 时长毫秒（可为空） */
  durationMs?: number;
}

/** 目标歌曲模板：用户歌单中的原始条目，用于与候选比对高亮 */
export interface TargetTrackTemplate {
  title: string;
  artist?: string;
}

interface ConfirmSyncDialogProps {
  session: PendingConfirmSession;
  /** 每首的选择结果：choiceIndex -> 候选歌曲 id */
  selections: Record<number, string>;
  /** 用户显式跳过的 choice：choiceIndex -> true */
  skips: Record<number, true>;
  onSelect: (index: number, songId: string) => void;
  /** 跳过当前这首（不写入任何版本） */
  onSkip: (index: number) => void;
  onConfirm: () => void;
  /** 放弃整个会话（任务归为中断） */
  onCancel: () => void;
  /** 稍后处理：仅收起弹窗，会话保留 */
  onDismiss: () => void;
  confirming: boolean;
  confirmError: string;
}

/** 文本与目标一致处（忽略大小写的子串）高亮 */
function HighlightText({
  text,
  target,
  className,
}: {
  text: string;
  target?: string;
  className: string;
}): ReactNode {
  if (!target) return <>{text}</>;
  const idx = text.toLocaleLowerCase().indexOf(target.toLocaleLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className={className}>{text.slice(idx, idx + target.length)}</span>
      {text.slice(idx + target.length)}
    </>
  );
}

/** 歌手串切分符：与 core 匹配逻辑（artistParts）保持一致，不切斜杠（乐队名常见斜杠） */
const ARTIST_SPLIT = /feat\.?|ft\.?|featuring|&|,|;|、/i;

/**
 * 歌手串高亮：候选歌手与目标可能使用不同分隔符（& / , / feat 等），
 * 整体子串匹配不到时按人名单词逐段高亮（忽略大小写，重叠区间合并）。
 */
function HighlightArtist({
  text,
  target,
  className,
}: {
  text: string;
  target?: string;
  className: string;
}): ReactNode {
  if (!target) return <>{text}</>;
  const lower = text.toLocaleLowerCase();
  // 整体一致时优先高亮连续子串
  const whole = lower.indexOf(target.toLocaleLowerCase());
  const ranges: Array<[number, number]> =
    whole !== -1
      ? [[whole, whole + target.length]]
      : target
          .split(ARTIST_SPLIT)
          .map((p) => p.trim())
          .filter(Boolean)
          .map((part) => {
            const idx = lower.indexOf(part.toLocaleLowerCase());
            return idx === -1
              ? null
              : ([idx, idx + part.length] as [number, number]);
          })
          .filter((r): r is [number, number] => r !== null);
  if (ranges.length === 0) return <>{text}</>;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(
      <span key={start} className={className}>
        {text.slice(start, end)}
      </span>,
    );
    cursor = end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

/** 封面图组件：防盗链 referer 置空，加载失败回退占位图标 */
function Cover({ template }: { template: CandidateDisplayTemplate }) {
  const [failed, setFailed] = useState(false);
  if (!template.coverUrl || failed) {
    return (
      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-surface-container-highest">
        <span className="material-symbols-outlined text-2xl text-outline">
          music_note
        </span>
      </span>
    );
  }
  return (
    <img
      src={template.coverUrl}
      alt={template.album ?? template.title}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-14 w-14 shrink-0 rounded-md object-cover"
    />
  );
}

/** 候选卡片：按固定模板参数渲染，歌名/歌手与目标一致处高亮 */
function CandidateCard({
  candidate,
  target,
  selected,
  onPick,
}: {
  candidate: CandidateDisplayTemplate;
  target: TargetTrackTemplate;
  selected: boolean;
  onPick: (songId: string) => void;
}) {
  return (
    <button
      onClick={() => onPick(candidate.id)}
      className={`flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition-colors ${
        selected
          ? "border-primary bg-primary/10"
          : "border-outline-variant bg-surface-container-lowest hover:border-primary"
      }`}
    >
      <Cover template={candidate} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-body-md text-body-md text-on-surface">
          <HighlightText
            text={candidate.title}
            target={target.title}
            className="font-medium text-primary"
          />
        </span>
        <span className="block truncate font-label-sm text-label-sm text-on-surface-variant">
          <HighlightArtist
            text={candidate.artist}
            target={target.artist}
            className="text-primary"
          />
        </span>
        {candidate.album && (
          <span className="block truncate font-label-sm text-label-sm text-outline">
            {candidate.album}
          </span>
        )}
      </span>
      {candidate.durationMs !== undefined && (
        <span className="shrink-0 font-label-mono text-label-mono text-outline">
          {formatDuration(candidate.durationMs)}
        </span>
      )}
      {selected && (
        <span className="material-symbols-outlined shrink-0 text-primary">
          check_circle
        </span>
      )}
    </button>
  );
}

/**
 * 同步待确认分步弹窗：一次展示一首同名歌曲的候选版本，
 * 选完自动进入下一首；全部选完才可确认创建歌单。
 * 挂载在 App 层，切换视图不丢失。
 * 布局：头部与底部固定，仅候选区域滚动（整体窗口不随内容撑开）。
 */
export default function ConfirmSyncDialog({
  session,
  selections,
  skips,
  onSelect,
  onSkip,
  onConfirm,
  onCancel,
  onDismiss,
  confirming,
  confirmError,
}: ConfirmSyncDialogProps) {
  const { t } = useI18n();
  const [current, setCurrent] = useState(0);
  /** 「放弃选择」二次确认：首次点击进入待确认态 */
  const [abandonConfirm, setAbandonConfirm] = useState(false);

  const { choices } = session;
  const total = choices.length;
  const choice = choices[Math.min(current, total - 1)];
  const skippedThis = skips[current] === true;
  // 每首歌都已选定或已跳过时，才允许确认创建歌单
  const allDecided = choices.every(
    (_, i) => selections[i] !== undefined || skips[i] === true,
  );

  // 目标歌曲模板（固定参数，供高亮比对与展示）
  const target: TargetTrackTemplate = {
    title: choice.query.title,
    artist: choice.query.artist,
  };

  const handlePick = (songId: string) => {
    log.info("confirm.pick", "选择候选版本", {
      title: choice.query.title,
      songId,
    });
    onSelect(current, songId);
    // 选完自动进入下一首（最后一首停留等待确认）
    if (current < total - 1) setCurrent((c) => Math.min(c + 1, total - 1));
  };

  /** 跳过当前这首：明确放弃该歌，不写入任何版本 */
  const handleSkip = () => {
    log.info("confirm.skip", "跳过当前歌曲", {
      title: choice.query.title,
      index: current,
    });
    onSkip(current);
    if (current < total - 1) setCurrent((c) => Math.min(c + 1, total - 1));
  };

  const handlePrevious = () => {
    log.debug("confirm.previous", "回看上一首", { index: current });
    setCurrent((c) => Math.max(0, c - 1));
  };

  const handleAbandon = () => {
    if (abandonConfirm) {
      setAbandonConfirm(false);
      onCancel();
    } else {
      setAbandonConfirm(true);
    }
  };

  return (
    <div className="dialog-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="dialog-panel-enter flex h-[32rem] max-h-[85vh] w-[36rem] flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container">
        {/* 选择态：头部与底部固定，仅候选区域滚动 */}
        <>
          <div className="flex items-center justify-between border-b border-outline-variant px-5 py-3">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-tertiary">
                playlist_add_check
              </span>
              <p className="font-body-md text-body-md font-medium">
                {t("confirmDialog.title")}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-label-sm text-label-sm text-on-surface-variant">
                {t("confirmDialog.step", { current: current + 1, total })}
              </span>
              {/* 稍后处理：仅收起弹窗，会话保留，可随时从同步历史重新打开 */}
              <button
                onClick={onDismiss}
                disabled={confirming}
                title={t("confirmDialog.dismiss")}
                className="flex items-center gap-1 rounded-md border border-outline-variant px-2 py-1 font-label-sm text-label-sm text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-sm">
                  schedule
                </span>
                {t("confirmDialog.dismiss")}
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {/* 目标歌曲（用户歌单里的歌名与歌手） */}
            <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3">
              <p className="font-label-mono text-label-mono text-outline">
                TARGET TRACK
              </p>
              <p className="mt-1 font-body-md text-body-md font-medium">
                {target.title}
              </p>
              {target.artist && (
                <p className="font-label-md text-label-md text-on-surface-variant">
                  {target.artist}
                </p>
              )}
            </div>

            {skippedThis && (
              <p className="mt-3 flex items-center gap-1.5 rounded-lg border border-secondary/40 bg-secondary/10 px-3 py-2 font-label-sm text-label-sm text-secondary">
                <span className="material-symbols-outlined text-sm">
                  skip_next
                </span>
                {t("confirmDialog.skippedNote")}
              </p>
            )}

            <p className="mt-4 font-label-sm text-label-sm text-on-surface-variant">
              {t("confirmDialog.pickHint")}
            </p>

            {/* 候选版本列表：按固定模板渲染（封面 + 歌名 + 歌手 + 专辑 + 时长） */}
            <ul className="mt-2 space-y-2">
              {choice.candidates.map((c) => (
                <li key={c.id}>
                  <CandidateCard
                    candidate={c}
                    target={target}
                    selected={selections[current] === c.id}
                    onPick={handlePick}
                  />
                </li>
              ))}
            </ul>

            {/* 跳过选项：让用户明确知道跳过的是哪一首；已跳过时可点击候选重新选择 */}
            <button
              onClick={handleSkip}
              disabled={confirming || skippedThis}
              title={
                skippedThis
                  ? t("confirmDialog.skippedNote")
                  : t("confirmDialog.skipHint")
              }
              className={`mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed px-3 py-2 font-label-md text-label-md transition-colors ${
                skippedThis
                  ? "border-secondary/50 bg-secondary/10 text-secondary"
                  : "border-outline-variant text-on-surface-variant hover:border-secondary hover:text-secondary"
              } disabled:opacity-60`}
            >
              <span className="material-symbols-outlined text-sm">
                skip_next
              </span>
              {skippedThis
                ? t("confirmDialog.skippedNote")
                : t("confirmDialog.skipThis")}
            </button>
          </div>

          {/* 底部操作：上一首 / 取消 / 确认 */}
          <div className="flex items-center gap-2 border-t border-outline-variant px-5 py-3">
            <button
              onClick={handlePrevious}
              disabled={current === 0 || confirming}
              className="flex items-center gap-1 rounded-lg border border-outline-variant px-3 py-2 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-sm">
                arrow_back
              </span>
              {t("confirmDialog.previous")}
            </button>
            <button
              onClick={handleAbandon}
              disabled={confirming}
              className={`flex items-center gap-1 rounded-lg border px-3 py-2 font-label-md text-label-md transition-colors disabled:opacity-40 ${
                abandonConfirm
                  ? "border-error bg-error/10 text-error hover:bg-error/15"
                  : "border-outline-variant text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
              }`}
            >
              <span className="material-symbols-outlined text-sm">
                {abandonConfirm ? "warning" : "close"}
              </span>
              {abandonConfirm
                ? t("confirmDialog.abandonConfirm")
                : t("confirmDialog.abandon")}
            </button>
            <button
              onClick={onConfirm}
              disabled={confirming || !allDecided}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md font-medium text-on-primary transition-colors hover:bg-primary/85 disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-sm">
                {confirming ? "progress_activity" : "task_alt"}
              </span>
              {confirming
                ? t("confirmDialog.confirming")
                : t("textCreator.confirmAndCreate")}
            </button>
          </div>

          {confirmError && (
            <p className="border-t border-outline-variant px-5 py-2 font-label-sm text-label-sm text-error">
              {confirmError}
            </p>
          )}
        </>
      </div>
    </div>
  );
}
