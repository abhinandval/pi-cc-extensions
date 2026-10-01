import assert from "node:assert/strict";
import test from "node:test";
import {
	codemodeCollapsedLines,
	codemodeExpandedBody,
	codemodeOutputLineCount,
	codemodeOutputText,
	codemodeSummaryText,
	createCodemodeResultComponent,
} from "../extensions/renderer/tool/codemode.ts";
import { toolCallSummary } from "../extensions/renderer/tool/names.ts";

const theme = { fg: (_color: string, text: string) => text } as any;

const HEADER = "Script completed\nWall time 1.9 seconds\nOutput:\n";

const call = (over: Record<string, unknown> = {}) => ({
	id: "c/1",
	name: "ffgrep",
	args: '{"pattern":"mcp","path":"src/"}',
	status: "ok",
	durationMs: 31,
	...over,
});

const result = (over: Record<string, unknown> = {}, calls: unknown[] = [call()]) => ({
	content: [
		{ type: "text", text: HEADER },
		{ type: "text", text: "--- grep ---\nnames.ts" },
	],
	details: { calls },
	...over,
});

test("输出正文：脚本头只切整块，折叠摘要不再多算 3 行", () => {
	assert.equal(codemodeOutputText(result()), "--- grep ---\nnames.ts");
	assert.equal(codemodeOutputLineCount(result()), 2);
	// 头与正文同一块时不切（与 pi 原生一致，头始终是独立 content 块）
	const glued = { content: [{ type: "text", text: `${HEADER}--- grep ---` }] };
	assert.equal(codemodeOutputLineCount(glued), 4);
});

test("汇总文案：运行中报进度，完成后报条数/失败数/输出行数", () => {
	assert.equal(codemodeSummaryText([], 0, false), "Done");
	assert.equal(codemodeSummaryText([call()], 0, false), "1 call");
	assert.equal(codemodeSummaryText([call(), call()], 1, false), "2 calls · 1 line output");
	assert.equal(
		codemodeSummaryText([call({ status: "error" }), call()], 2, false),
		"2 calls · 1 failed · 2 lines output",
	);
	assert.equal(
		codemodeSummaryText([call({ status: "running" }), call({ status: "ok" })], 0, true),
		"1 call running · 1 done",
	);
	assert.equal(codemodeSummaryText([], 0, true), "running");
});

test("折叠态：子调用全用 ├，最后一行用 └ 收汇总", () => {
	const lines = codemodeCollapsedLines({
		result: result(),
		theme,
		running: false,
		isError: false,
		width: 100,
	});
	assert.deepEqual(lines, [
		'   ├ ✓ Ffgrep "mcp" in src/ 31ms',
		"   └ 1 call · 2 lines output • click to show more",
	]);
});

test("折叠态：运行中用转轮帧，汇总报 running", () => {
	const lines = codemodeCollapsedLines({
		result: result({}, [
			call({ status: "running", durationMs: undefined }),
			call({ id: "c/2", name: "fffind", args: '{"pattern":"mcp"}', status: "running" }),
		]),
		theme,
		running: true,
		isError: false,
		width: 100,
	});
	assert.match(lines[0]!, /^ {3}├ \S Ffgrep "mcp" in src\/$/);
	assert.equal(lines[2], "   └ 2 calls running");
});

test("折叠态：子调用过多时只列最近 8 条", () => {
	const many = Array.from({ length: 11 }, (_, i) =>
		call({
			id: `c/${i + 1}`,
			name: "read",
			args: `{"path":"src/f${i + 1}.ts"}`,
			status: "ok",
			durationMs: 5 + i,
		}),
	);
	const lines = codemodeCollapsedLines({
		result: result({}, many),
		theme,
		running: false,
		isError: false,
		width: 100,
	});
	assert.equal(lines[0], "   ├ … 3 earlier calls");
	assert.equal(lines.length, 10);
	assert.match(lines[1]!, /^ {3}├ ✓ Read src\/f4\.ts 8ms$/);
	assert.equal(lines[9], "   └ 11 calls · 2 lines output • click to show more");
});

test("折叠态：没有子调用时不画衔接符", () => {
	const lines = codemodeCollapsedLines({
		result: result({}, []),
		theme,
		running: false,
		isError: true,
		width: 100,
	});
	assert.deepEqual(lines, ["   2 lines output • click to show more"]);
});

test("折叠态：认不出的参数（pi 截断过）原样当载荷", () => {
	const lines = codemodeCollapsedLines({
		result: result({}, [call({ args: '{"pattern":"mcp","p…' })]),
		theme,
		running: false,
		isError: false,
		width: 120,
	});
	assert.match(lines[0]!, /^ {3}├ ✓ Ffgrep \{"pattern":"mcp","p… 31ms$/);
});

test("汇总片段：宽度不够时从尾部丢，不断词", () => {
	const lines = codemodeCollapsedLines({
		result: result({}, [call(), call({ id: "c/2", status: "error" })]),
		theme,
		running: false,
		isError: true,
		width: 60,
	});
	assert.equal(lines.at(-1), "   └ 2 calls · 1 failed • click to show more");
});

test("展开正文：全部子调用（含错误）+ 去头输出 + 全量输出路径", () => {
	const body = codemodeExpandedBody({
		content: [
			{ type: "text", text: HEADER },
			{ type: "text", text: "--- grep ---\nnames.ts" },
		],
		details: {
			calls: [
				call(),
				call({
					id: "c/2",
					name: "fffind",
					args: '{"pattern":"mcp"}',
					status: "error",
					error: "boom\nbang",
				}),
			],
			fullOutputPath: "C:\\tmp\\out.txt",
		},
	});
	assert.equal(
		body,
		[
			'ffgrep {"pattern":"mcp","path":"src/"} 31ms',
			'fffind {"pattern":"mcp"} 31ms',
			"    boom",
			"    bang",
			"",
			"--- grep ---",
			"names.ts",
			"",
			"Full output: C:\\tmp\\out.txt",
		].join("\n"),
	);
});

test("折叠组件：只有汇总行是展开入口，运行中不可展开，尺寸结果缓存", () => {
	const running = createCodemodeResultComponent({
		result: result(),
		theme,
		running: true,
		isError: false,
	});
	assert.equal(
		running.isCollapsedHintLine("   └ 1 call · 2 lines output • click to show more"),
		false,
	);

	const done = createCodemodeResultComponent({
		result: result(),
		theme,
		running: false,
		isError: false,
	});
	assert.equal(done.isCollapsedHintLine("   └ 1 call · 2 lines output • click to show more"), true);
	assert.equal(done.isCollapsedHintLine('   ├ ✓ Ffgrep "mcp" in src/ 31ms'), false);
	assert.equal(done.render(100), done.render(100));
	assert.notEqual(done.render(100), done.render(80));
	done.invalidate();
	assert.deepEqual(done.render(100), done.render(100));
});

test("调用行：跳过 // @options 取首行代码，后面还有内容时补省略号", () => {
	assert.deepEqual(
		toolCallSummary("codemode", {
			code: '// @options: {"max_output_tokens": 1000}\nconst a = await tools.read({ path: "a.ts" })\nreturn a',
		}),
		{ main: "Codemode", detail: "", payload: 'const a = await tools.read({ path: "a.ts" }) …' },
	);
	// 只有一行：不加省略号
	assert.deepEqual(toolCallSummary("codemode", { code: "return 1" }), {
		main: "Codemode",
		detail: "",
		payload: "return 1",
	});
	// 空脚本：只剩标题
	assert.deepEqual(toolCallSummary("codemode", { code: "// @options: {}\n" }), {
		main: "Codemode",
		detail: "",
	});
});
