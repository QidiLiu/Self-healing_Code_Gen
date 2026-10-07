import { describe, it } from "node:test"
import assert from "node:assert/strict"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import {
  applyReplyInstructions,
  parseReplyInstructions,
} from "../reply.js"
import { splitBlocks, joinBlocks } from "../requirements.js"

/** The real-world requirements file that exposed the delete-regex data loss bug. */
const MINESWEEPERS = `一个经典扫雷游戏的复刻原型，使用HTML/CSS/JS在单个网页中运行。

玩家通过鼠标点击揭开方块，并标记地雷。

输入：
- 鼠标左键点击：揭开方块
- 鼠标右键点击：标记/取消标记旗帜
- 键盘R键：重新开始

输出：
- Canvas画布渲染游戏画面
- 揭开后的数字显示周围8格的地雷数量
- 踩到地雷时触发爆炸动画，游戏结束

核心机制：
- 空白方块自动递归展开相邻区域
- 获胜条件：揭开所有非地雷方块

不包含：NPC、关系系统、战斗、采矿

---

支持CSV导出

---

需要深色模式切换按钮`

function withTempFile<T>(content: string, fn: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reply-test-"))
  try {
    const file = path.join(dir, "current.md")
    fs.writeFileSync(file, content, "utf-8")
    return fn(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("splitBlocks / joinBlocks", () => {
  it("round-trips block structure", () => {
    const blocks = splitBlocks(MINESWEEPERS)
    assert.equal(blocks.length, 3)
    assert.equal(joinBlocks(blocks), MINESWEEPERS.trim() + "\n")
  })

  it("tolerates separators with surrounding whitespace", () => {
    assert.deepEqual(splitBlocks("a\n\n  ---  \n\nb"), ["a", "b"])
  })
})

describe("applyReplyInstructions - delete", () => {
  it("removes only the matching block and leaves the rest intact", () => {
    withTempFile(MINESWEEPERS, (file) => {
      const before = fs.readFileSync(file, "utf-8")

      const result = applyReplyInstructions(
        parseReplyInstructions("删除需求: CSV导出"),
        file,
      )

      assert.equal(result.ok, true, JSON.stringify(result))

      const after = fs.readFileSync(file, "utf-8")
      const blocks = splitBlocks(after)

      // Regression: the old regex ate everything up to the keyword line,
      // turning a 655 char file into a single newline.
      assert.ok(after.length > 200, `file was gutted: ${JSON.stringify(after)}`)
      assert.equal(blocks.length, 2)
      assert.ok(!after.includes("CSV导出"))
      assert.ok(after.includes("一个经典扫雷游戏的复刻原型"))
      assert.ok(after.includes("需要深色模式切换按钮"))
      assert.ok(before.length > after.length)
    })
  })

  it("deletes every block containing one of several keywords", () => {
    withTempFile(MINESWEEPERS, (file) => {
      const result = applyReplyInstructions(
        parseReplyInstructions("删除需求: CSV导出、深色模式"),
        file,
      )

      assert.equal(result.ok, true)
      assert.equal(splitBlocks(fs.readFileSync(file, "utf-8")).length, 1)
    })
  })

  it("refuses an unknown keyword and leaves the file byte-identical", () => {
    withTempFile(MINESWEEPERS, (file) => {
      const before = fs.readFileSync(file, "utf-8")
      const result = applyReplyInstructions(
        parseReplyInstructions("删除需求: 完全不存在的关键词"),
        file,
      )

      assert.equal(result.ok, false)
      assert.match((result as { error: string }).error, /not found/i)
      assert.equal(fs.readFileSync(file, "utf-8"), before)
    })
  })
})

describe("applyReplyInstructions - modify", () => {
  it("replaces exactly the matching block", () => {
    withTempFile(MINESWEEPERS, (file) => {
      const result = applyReplyInstructions(
        parseReplyInstructions(
          "修改需求: 深色模式切换按钮\n新内容: 需要深色模式和浅色模式切换按钮，带系统偏好记忆",
        ),
        file,
      )

      assert.equal(result.ok, true, JSON.stringify(result))

      const after = fs.readFileSync(file, "utf-8")
      assert.equal(splitBlocks(after).length, 3)
      assert.ok(after.includes("系统偏好记忆"))
      assert.ok(!after.includes("需要深色模式切换按钮\n"))
    })
  })

  it("rejects a modify with no 新内容 line instead of deleting the block", () => {
    withTempFile(MINESWEEPERS, (file) => {
      const before = fs.readFileSync(file, "utf-8")
      const result = applyReplyInstructions(
        parseReplyInstructions("修改需求: CSV导出"),
        file,
      )

      assert.equal(result.ok, false)
      assert.match((result as { error: string }).error, /新内容/)
      assert.equal(fs.readFileSync(file, "utf-8"), before)
    })
  })

  it("rejects an ambiguous keyword rather than clobbering every match", () => {
    const content = [
      "第一块提到地雷",
      "",
      "---",
      "",
      "第二块也提到地雷",
      "",
      "---",
      "",
      "第三块内容足够长以通过校验要求",
    ].join("\n")

    withTempFile(content, (file) => {
      assert.equal(splitBlocks(content).length, 3)

      const result = applyReplyInstructions(
        parseReplyInstructions("修改需求: 地雷\n新内容: 只有这一个块应该被替换，内容足够长"),
        file,
      )

      assert.equal(result.ok, false)
      assert.match((result as { error: string }).error, /matches 2 blocks/)
      assert.equal(fs.readFileSync(file, "utf-8"), content)
    })
  })
})

describe("applyReplyInstructions - add", () => {
  it("appends a new block without leaking separators or markers", () => {
    withTempFile(MINESWEEPERS, (file) => {
      const result = applyReplyInstructions(
        parseReplyInstructions("新增需求:\n游戏结束后显示最终成绩与用时统计"),
        file,
      )

      assert.equal(result.ok, true, JSON.stringify(result))

      const after = fs.readFileSync(file, "utf-8")
      assert.equal(splitBlocks(after).length, 4)
      assert.ok(after.includes("游戏结束后显示最终成绩与用时统计"))
      assert.ok(!after.includes("[Email 指令"))
      assert.ok(!after.includes("[指令"))
    })
  })

  it("rejects empty content", () => {
    withTempFile(MINESWEEPERS, (file) => {
      const before = fs.readFileSync(file, "utf-8")
      const result = applyReplyInstructions(
        [{ type: "add", keyword: "", content: "   " }],
        file,
      )

      assert.equal(result.ok, false)
      assert.equal(fs.readFileSync(file, "utf-8"), before)
    })
  })
})

describe("applyReplyInstructions - transactionality", () => {
  it("applies nothing when a later instruction in the batch fails", () => {
    withTempFile(MINESWEEPERS, (file) => {
      const before = fs.readFileSync(file, "utf-8")
      const result = applyReplyInstructions(
        [
          { type: "delete", keyword: "CSV导出", content: "" },
          { type: "delete", keyword: "根本不存在的关键词", content: "" },
        ],
        file,
      )

      assert.equal(result.ok, false)
      assert.equal(fs.readFileSync(file, "utf-8"), before, "batch must be atomic")
    })
  })

  it("refuses an edit that would leave the file empty", () => {
    withTempFile("唯一的一段需求内容在这里结束", (file) => {
      const result = applyReplyInstructions(
        parseReplyInstructions("删除需求: 唯一"),
        file,
      )

      assert.equal(result.ok, false)
      assert.match((result as { error: string }).error, /invalid requirements/i)
      assert.equal(fs.readFileSync(file, "utf-8"), "唯一的一段需求内容在这里结束")
    })
  })

  it("writes a backup of the previous content", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reply-bak-"))
    try {
      const file = path.join(dir, "current.md")
      const backup = path.join(dir, "requirements.bak.md")
      fs.writeFileSync(file, MINESWEEPERS, "utf-8")

      const result = applyReplyInstructions(
        parseReplyInstructions("删除需求: CSV导出"),
        file,
        backup,
      )

      assert.equal(result.ok, true)
      assert.equal(fs.readFileSync(backup, "utf-8"), MINESWEEPERS)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("parseReplyInstructions", () => {
  it("parses multiple blocks separated by ---", () => {
    const instructions = parseReplyInstructions(
      [
        "修改需求: 输入验证",
        "新内容: 输入必须是 1-100 的正整数，超出范围提示错误",
        "---",
        "新增需求:",
        "增加深色模式切换按钮",
        "---",
        "删除需求: CSV导出",
      ].join("\n"),
    )

    assert.equal(instructions.length, 3)
    assert.deepEqual(instructions[0], {
      type: "modify",
      keyword: "输入验证",
      content: "输入必须是 1-100 的正整数，超出范围提示错误",
    })
    assert.deepEqual(instructions[1], {
      type: "add",
      keyword: "",
      content: "增加深色模式切换按钮",
    })
    assert.deepEqual(instructions[2], {
      type: "delete",
      keyword: "CSV导出",
      content: "",
    })
  })

  it("accepts fullwidth and halfwidth colons", () => {
    assert.equal(parseReplyInstructions("删除需求：CSV导出")[0].keyword, "CSV导出")
    assert.equal(parseReplyInstructions("删除需求: CSV导出")[0].keyword, "CSV导出")
  })

  it("strips quoted-reply headers", () => {
    const body = [
      "> 在 2026-10-07 Someone 写道：",
      "> 请删除这个功能",
      "",
      "删除需求: 音效",
    ].join("\n")

    const instructions = parseReplyInstructions(body)
    assert.equal(instructions.length, 1)
    assert.equal(instructions[0].keyword, "音效")
  })

  it("does not treat a 新内容 body as a command", () => {
    const body = "修改需求: 输入验证\n新内容: 规则如下\n删除需求: 这个词只是正文的一部分"
    const instructions = parseReplyInstructions(body)

    assert.equal(instructions.length, 1)
    assert.equal(instructions[0].type, "modify")
    assert.match(instructions[0].content, /这个词只是正文的一部分/)
  })

  it("handles HTML pasted from a mail client", () => {
    const html = "<div>修改需求: 输入验证</div><div>新内容: 必须是正整数</div>"
    const instructions = parseReplyInstructions(html)

    assert.equal(instructions.length, 1)
    assert.equal(instructions[0].keyword, "输入验证")
  })

  it("returns nothing for unrecognised text", () => {
    assert.deepEqual(parseReplyInstructions("looks good to me"), [])
  })
})
