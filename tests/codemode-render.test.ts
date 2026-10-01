import assert from "node:assert/strict";
import test from "node:test";
import {
	codemodeCalls,
	codemodeCollapsedLines,
	codemodeExpandedBody,
	codemodeOutputLineCount,
	codemodeOutputText,
	codemodeSummaryParts,
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

/** 汇总行是片段用 ` · ` 拼的，测试里拼回字符串更好读。 */
const summaryText = (calls: any[], outputLines: number, running: boolean) =>
	codemodeSummaryParts(calls, outputLines, running).join(" · ");

test("汇总文案：运行中报进度，完成后报条数/失败数/输出行数", () => {
	assert.equal(summaryText([], 0, false), "Done");
	assert.equal(summaryText([call()], 0, false), "1 call");
	assert.equal(summaryText([call(), call()], 1, false), "2 calls · 1 line output");
	assert.equal(
		summaryText([call({ status: "error" }), call()], 2, false),
		"2 calls · 1 failed · 2 lines output",
	);
	assert.equal(
		summaryText([call({ status: "running" }), call({ status: "ok" })], 0, true),
		"1 call running · 1 done",
	);
	assert.equal(summaryText([], 0, true), "running…");
});

test("折叠态：子调用带 detail 时接在标题后（与工具组行一致）", () => {
	const lines = codemodeCollapsedLines({
		result: result({}, [call({ name: "read", args: '{"path":"src/a.ts","offset":10,"limit":1}' })]),
		theme,
		running: false,
		isError: false,
		width: 100,
	});
	assert.equal(lines[0], "   ├ ✓ Read src/a.ts (offset=10, limit=1) 31ms");
});

test("异常数据不崩：calls 非数组、元素为 null、args 非字符串", () => {
	const messy = { content: [], details: { calls: "nope" } };
	assert.deepEqual(codemodeCalls(messy), []);
	assert.deepEqual(
		codemodeCollapsedLines({ result: messy, theme, running: false, isError: false, width: 100 }),
		["   Done • click to show more"],
	);

	const withNulls = result({}, [null, { name: "read" }, call({ args: 42 })]);
	const lines = codemodeCollapsedLines({
		result: withNulls,
		theme,
		running: false,
		isError: false,
		width: 100,
	});
	// 没带 status 的调用按运行中处理（braille 帧随挂钟变，用正则）
	assert.match(lines[0]!, /^ {3}├ \S Tool$/);
	assert.match(lines[1]!, /^ {3}├ \S Read$/);
	assert.match(lines[2]!, /^ {3}├ \S Ffgrep 31ms$/);
	assert.equal(lines[3], "   └ 3 calls · 2 lines output • click to show more");
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

test("运行中同样只列最近 8 条", () => {
	const many = Array.from({ length: 11 }, (_, i) =>
		call({
			id: `c/${i + 1}`,
			name: "read",
			args: `{"path":"src/f${i + 1}.ts"}`,
			status: "running",
			durationMs: undefined,
		}),
	);
	const lines = codemodeCollapsedLines({
		result: result({}, many),
		theme,
		running: true,
		isError: false,
		width: 100,
	});
	assert.equal(lines[0], "   ├ … 3 earlier calls");
	assert.equal(lines.length, 10);
	assert.equal(lines.at(-1), "   └ 11 calls running");
});

test("折叠组件：只有汇总行是展开入口，运行中不可展开", () => {
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
	assert.deepEqual(done.render(100), [
		'   ├ ✓ Ffgrep "mcp" in src/ 31ms',
		"   └ 1 call · 2 lines output • click to show more",
	]);
});

test("折叠态：hover 时展开提示用 text 色（与其它折叠卡一致）", () => {
	const tagged = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as any;
	// 带标签的 theme 桩里标签算可见宽度，给足宽度免得被截断
	const base = { result: result(), theme: tagged, running: false, isError: false, width: 140 };
	// truncateToWidth 会在行尾补 ANSI reset，断言不锚尾
	assert.match(codemodeCollapsedLines(base).at(-1)!, /<dim>• click to show more/);
	assert.match(
		codemodeCollapsedLines({ ...base, hovered: true }).at(-1)!,
		/<text>• click to show more/,
	);

	// 组件在 render() 内取 hover，跟着鼠标 motion 的 requestRender 走
	let hovered = false;
	const component = createCodemodeResultComponent({
		result: result(),
		theme: tagged,
		running: false,
		isError: false,
		isHovered: () => hovered,
	});
	assert.match(component.render(100).at(-1)!, /<dim>• click/);
	hovered = true;
	assert.match(component.render(100).at(-1)!, /<text>• click/);
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
