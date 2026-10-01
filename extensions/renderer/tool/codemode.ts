/**
 * codemode 的结果渲染：折叠态把子调用摊成工具组那样的树，最后一行用 └ 收尾。
 *
 * 数据来自 `result.details.calls`（CodemodeNestedCall[]，partial 更新里也有），所以运行中就能
 * 看到子调用进度。两个坑：
 *
 * - 子调用不会单独成行：pi 会跳过带 `parentToolCallId` 的 tool_execution_start，进度只能在这里显示。
 * - 输出以 "Script completed\nWall time …\nOutput:\n" 开头（pi 原生也切掉），行数统计与展开正文都得去掉它，
 *   否则折叠摘要会多算 3 行。
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../utils/ansi-text.ts";
import { toolLoadingIcon } from "../../utils/tool-loading-icon.ts";
import { sanitizeToolResultText } from "../../utils/tool-result-sanitize.ts";
import { mcpToolTitle } from "./mcp-title.ts";
import {
	type ToolCallSummary,
	humanizeToolLabel,
	renderToolSummary,
	toolCallSummary,
} from "./names.ts";
import { showMoreHintText } from "./show-more-hint.ts";
import { headTruncateToWidth, toolViewportWidth } from "./result.ts";

export const CODEMODE_TOOL_NAME = "codemode";

/** 折叠态最多列几条子调用（与 pi 原生一致，更早的折叠成一行）。 */
const COLLAPSED_CALL_LIMIT = 8;
/** 折叠态正文缩进，与 `   ↳ …` 对齐。 */
const INDENT = "   ";

/** 脚本结果头；只有整块正文恰好等于它时才算头。 */
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

export type CodemodeNestedCall = {
	name?: unknown;
	/** 紧凑 JSON；过长时 pi 会截断，截断后 JSON.parse 会失败。 */
	args?: unknown;
	status?: unknown;
	durationMs?: unknown;
	error?: unknown;
	cost?: unknown;
};

export function codemodeCalls(result: any): CodemodeNestedCall[] {
	const calls = result?.details?.calls;
	return Array.isArray(calls) ? calls : [];
}

/** 去掉脚本头之后的输出正文（已清理终端转义）。 */
export function codemodeOutputText(result: any): string {
	const content = Array.isArray(result?.content) ? result.content : [];
	const blocks = content
		.filter((item: any) => item?.type === "text")
		.map((item: any) => String(item?.text ?? ""));
	if (blocks.length > 0 && SCRIPT_HEADER.test(blocks[0]!)) blocks.shift();
	return sanitizeToolResultText(blocks.join("\n"), 16_384).trim();
}

export function codemodeOutputLineCount(result: any): number {
	const text = codemodeOutputText(result).replace(/\n+$/, "");
	return text ? text.split("\n").length : 0;
}

/** 汇总行文案片段（按重要度先后排列，渲染时从尾部丢以适配宽度）。 */
export function codemodeSummaryParts(
	calls: readonly CodemodeNestedCall[],
	outputLines: number,
	running: boolean,
): string[] {
	const total = calls.length;
	const failed = calls.filter((call) => call?.status === "error").length;
	const runningCount = calls.filter((call) => !call?.status || call?.status === "running").length;
	const parts: string[] = [];
	if (running) {
		if (runningCount)
			parts.push(`${runningCount} ${runningCount === 1 ? "call" : "calls"} running`);
		const done = total - runningCount;
		if (done) parts.push(`${done} done`);
		if (failed) parts.push(`${failed} failed`);
		return parts.length ? parts : ["running"];
	}
	if (total) parts.push(`${total} ${total === 1 ? "call" : "calls"}`);
	if (failed) parts.push(`${failed} failed`);
	if (outputLines) parts.push(`${outputLines} ${outputLines === 1 ? "line" : "lines"} output`);
	return parts.length ? parts : ["Done"];
}

/** 汇总行文案：运行中报进度，完成后报条数与输出行数。 */
export function codemodeSummaryText(
	calls: readonly CodemodeNestedCall[],
	outputLines: number,
	running: boolean,
): string {
	return codemodeSummaryParts(calls, outputLines, running).join(" · ");
}

/** 宽度不够时从尾部丢片段（先丢输出行数，再丢条数），不断词。 */
function fitSummaryParts(parts: readonly string[], width: number): string {
	const kept = [...parts];
	while (kept.length > 1 && visibleWidth(kept.join(" · ")) > width) kept.pop();
	const text = kept.join(" · ");
	return visibleWidth(text) <= width ? text : headTruncateToWidth(text, width);
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 与 pi 原生一致：不到 1 分显示两位有效数字。 */
export function formatCodemodeCost(cost: number): string {
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

/** 单次子调用的耗时/费用（纯文本，着色由调用方决定）。 */
function callMeta(call: CodemodeNestedCall): string[] {
	const out: string[] = [];
	const duration = Number(call?.durationMs);
	if (Number.isFinite(duration) && duration >= 0 && call?.durationMs !== undefined) {
		out.push(formatDuration(duration));
	}
	const cost = Number(call?.cost);
	if (Number.isFinite(cost) && cost > 0) out.push(formatCodemodeCost(cost));
	return out;
}

/** 子调用参数：能解析就复用字段链摘要，解析不了（pi 截断过）就贴原文。 */
function callSummary(call: CodemodeNestedCall): ToolCallSummary {
	const name = String(call?.name ?? "tool");
	const title = mcpToolTitle({ toolName: name }) ?? humanizeToolLabel(name);
	const raw = typeof call?.args === "string" ? call.args : "";
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return toolCallSummary(name, parsed, { title, variant: "default" });
			}
		} catch {
			// 截断过的参数：原样当载荷显示
		}
		return { main: title, detail: "", payload: raw };
	}
	return { main: title, detail: "" };
}

function statusIcon(status: unknown, theme: any): string {
	switch (status) {
		case "ok":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("muted", "⊘");
		default:
			// 运行中：帧在 render() 内取，动画定时器只负责 requestRender
			return theme.fg("accent", toolLoadingIcon());
	}
}

function callRow(call: CodemodeNestedCall, theme: any, rowWidth: number): string {
	const fg = theme.fg.bind(theme);
	const prefix = `${INDENT}${fg("dim", "├")} ${statusIcon(call?.status, theme)} `;
	const suffix = callMeta(call)
		.map((text) => ` ${fg("dim", text)}`)
		.join("");
	const mainWidth = Math.max(0, rowWidth - visibleWidth(prefix) - visibleWidth(suffix));
	const row = `${prefix}${renderToolSummary(callSummary(call), mainWidth, fg)}${suffix}`;
	return truncateToWidth(row, rowWidth, "");
}

/**
 * 折叠态（含运行中的 partial 更新）的行：子调用全用 ├，最后一行用 └ 收汇总，
 * 与工具组的树一致。
 */
export function codemodeCollapsedLines(options: {
	result: any;
	theme: any;
	running: boolean;
	isError: boolean;
	width: number;
}): string[] {
	const { result, theme, running, isError } = options;
	const fg = theme.fg.bind(theme);
	const calls = codemodeCalls(result);
	const rowWidth = toolViewportWidth(options.width);
	const shown = running ? calls : calls.slice(-COLLAPSED_CALL_LIMIT);
	const lines: string[] = [];
	if (shown.length < calls.length) {
		const hidden = calls.length - shown.length;
		lines.push(
			truncateToWidth(
				`${INDENT}${fg("dim", "├")} ${fg("dim", `… ${hidden} earlier ${hidden === 1 ? "call" : "calls"}`)}`,
				rowWidth,
				"",
			),
		);
	}
	for (const call of shown) lines.push(callRow(call, theme, rowWidth));

	const summary = codemodeSummaryParts(calls, codemodeOutputLineCount(result), running);
	// 没有子调用时不画衔接符，避免孤零零一个 └
	const prefix = shown.length > 0 ? `${INDENT}${fg("dim", "└")} ` : INDENT;
	const hint = running ? "" : ` ${fg("dim", `• ${showMoreHintText()}`)}`;
	const bodyWidth = Math.max(1, rowWidth - visibleWidth(prefix) - visibleWidth(hint));
	const body = fg(isError ? "error" : "muted", fitSummaryParts(summary, bodyWidth));
	lines.push(truncateToWidth(`${prefix}${body}${hint}`, rowWidth, ""));
	return lines;
}

/** 展开态正文：全部子调用（含错误文本）+ 去掉脚本头的输出 + 全量输出路径。 */
export function codemodeExpandedBody(result: any): string {
	const parts: string[] = [];
	const calls = codemodeCalls(result);
	if (calls.length > 0) {
		parts.push(
			calls
				.map((call) => {
					const name = String(call?.name ?? "tool");
					const raw = typeof call?.args === "string" ? call.args : "";
					const meta = callMeta(call);
					const head = [name, raw, ...meta].filter(Boolean).join(" ");
					const error =
						typeof call?.error === "string" && call.error
							? `\n    ${call.error.split("\n").join("\n    ")}`
							: "";
					return `${head}${error}`;
				})
				.join("\n"),
		);
	}
	const output = codemodeOutputText(result);
	if (output) parts.push(output);
	const full = result?.details?.fullOutputPath;
	if (typeof full === "string" && full.trim()) parts.push(`Full output: ${full.trim()}`);
	return parts.join("\n\n");
}

/**
 * 折叠态结果组件。运行中的 braille 帧按挂钟变化，不缓存；只有汇总行是展开入口，
 * 与 diff 卡一致。
 */
export function createCodemodeResultComponent(options: {
	result: any;
	theme: any;
	running: boolean;
	isError: boolean;
}): any {
	const { result, theme, running, isError } = options;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number): string[] {
			if (!running && cachedLines && cachedWidth === width) return cachedLines;
			const lines = codemodeCollapsedLines({ result, theme, running, isError, width });
			if (!running) {
				cachedWidth = width;
				cachedLines = lines;
			}
			return lines;
		},
		invalidate(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
		isCollapsedHintLine(plainLine: string): boolean {
			return !running && /(click to show more|to show more)\s*$/.test(stripAnsi(plainLine));
		},
	};
}
