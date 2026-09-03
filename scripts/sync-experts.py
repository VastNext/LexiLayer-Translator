#!/usr/bin/env python3
from pathlib import Path
import argparse
import json
import os
import re
import subprocess
import sys

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path(os.environ.get("VAST_EXPERT_PROMPTS_DIR", ROOT.parent / "LexiLayerPrompts"))
DISPLAY_NAMES = {
    "ao3": "同人文学专家",
    "bilingual-mix": "双语混合专家",
    "chess": "国际象棋专家",
    "classical-to-modern": "古文今译专家",
    "database": "数据库专家",
    "design": "设计师",
    "ebook": "电子书专家",
    "ecommerce": "电商翻译专家",
    "fiction": "小说翻译专家",
    "financial": "金融翻译专家",
    "game": "游戏翻译专家",
    "github": "GitHub 专家",
    "legal": "法律翻译专家",
    "medical": "医学翻译大师",
    "music": "音乐翻译专家",
    "news": "新闻翻译专家",
    "paper": "论文翻译专家",
    "paragraph-summarizer": "段落摘要",
    "paraphrase": "意译润色专家",
    "plain-english": "通俗英语专家",
    "reddit": "Reddit 专家",
    "steam": "Steam 社区专家",
    "subliminal-lingo": "潜意识语言专家",
    "technology": "科技类翻译大师",
    "twitter": "社交媒体专家",
    "vocabulary-assistant": "词汇助手",
    "web3": "Web3 翻译专家",
    "word-by-word": "逐句对照专家",
    "wyw": "文言雅译专家",
}
DISPLAY_DESCRIPTIONS = {
    "technology": "翻译代码、API 文档和技术教程，保留命令、路径、标识符与专业术语。",
    "medical": "翻译医学、临床和生命科学内容，准确处理诊断、药物、剂量、单位与医学编码。",
    "design": "翻译设计、艺术和创意内容，保留风格、材质、技法、作品名称与审美意图。",
    "legal": "翻译合同、法规和法律条款，明确保留定义、义务、条件、例外与管辖关系。",
    "financial": "翻译财报、投资和市场内容，准确保留金额、币种、比例、日期、风险与金融术语。",
    "news": "翻译新闻和时事报道，保持事实、时间线、消息来源、引语与中性新闻语气。",
    "paper": "翻译论文和学术材料，保留研究方法、证据、引用、统计数据与论证结构。",
    "fiction": "翻译小说和叙事文本，保留人物声音、对白、视角、气氛、节奏与文学意象。",
    "plain-english": "把复杂或官样的表达翻得更清楚直接，但不删减条件、限制、警告和关键信息。",
    "bilingual-mix": "翻译时保留重要原文术语，并在必要处附上简洁对应表达，适合术语学习和对照阅读。",
    "word-by-word": "尽量保持原文句子和段落对应关系，适合逐句对照、学习和检查译文完整性。",
    "paraphrase": "在不改变事实和意图的前提下进行自然意译与润色，适合需要更流畅的成稿。",
    "github": "翻译 GitHub Issue、PR 和 README，保留命令、路径、Markdown、提交与协作术语。",
    "reddit": "翻译 Reddit 等社区讨论，保留口语、幽默、俚语、社区梗和发言者语气。",
    "twitter": "翻译短帖和社交媒体内容，保留简短节奏、话题标签、提及、链接与传播语气。",
    "game": "翻译游戏文本和玩家指南，统一处理角色、道具、技能、界面、数值与玩家口吻。",
    "music": "翻译歌词和音乐内容，保留歌词结构、节奏、意象、音乐术语、歌手与作品名称。",
    "ecommerce": "翻译商品页和电商营销内容，兼顾卖点、规格、价格、行动号召与自然的销售语气。",
    "web3": "翻译区块链、加密资产和去中心化应用内容，保留协议、代币、钱包与技术术语。",
    "classical-to-modern": "把文言文、古籍和史料译成现代汉语，解释古代表达、典故、人物和历史语境。",
    "chess": "翻译棋谱、开局和对局分析，保留着法记谱、变例、棋手名称与战术关系。",
    "ebook": "翻译长篇电子书，持续统一人名、术语、叙事语气和段落结构，适合分章阅读。",
    "ao3": "翻译 AO3 和同人作品，保留圈内术语、人物关系、标签、警告与角色语气。",
    "steam": "翻译 Steam 评论和玩家社区内容，保留游戏术语、口语、评价态度与社区表达。",
    "subliminal-lingo": "翻译需要保留潜台词、暗示和语言模式的内容，尽量不抹平隐含语气与表达层次。",
    "database": "翻译数据库和 SQL 内容，保留表结构、字段、查询、约束、执行计划与数据库术语。",
    "paragraph-summarizer": "翻译段落摘要和提要，保留中心论点、关键证据、专名、数字与可执行结论。",
    "vocabulary-assistant": "用于词汇学习和术语理解，突出词义、上下文、搭配与必要的原文表达。",
    "wyw": "把现代或外语内容译得更古雅凝练，保留意象、典故、情绪、节奏和含蓄的文学表达。",
}
DISPLAY_ORDER = [
    "technology", "medical", "design", "legal", "financial", "news", "paper", "fiction", "plain-english",
    "bilingual-mix", "word-by-word", "paraphrase", "github", "reddit", "twitter", "game", "music", "ecommerce",
    "web3", "classical-to-modern", "chess", "ebook", "ao3", "steam", "subliminal-lingo",
]
DISPLAY_ORDER_INDEX = {expert_id: index for index, expert_id in enumerate(DISPLAY_ORDER)}


def source_revision(source: Path) -> str:
    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=source, capture_output=True, text=True, check=True,
    )
    if status.stdout.strip():
        raise ValueError("Expert repository must be clean so the snapshot matches its recorded revision.")
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=source, capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()


def semantic_prompt(data: dict) -> str:
    task = str(data["task"]["single"])
    task = re.sub(r"^Translate the supplied passage into \{\{target_language\}\}\.\s*", "", task)
    task = re.sub(r"\s*Return only the translated passage and do not add commentary\.\s*$", "", task)
    invariants = " ".join(str(item) for item in data["quality"]["invariants"])
    return f"{task.strip()} {invariants.strip()}".strip()


def display_description(summary: str) -> str:
    match = re.fullmatch(r"面向\s*(.+?)\s*场景的\s*VastNext\s*翻译专家。?", summary.strip())
    if match:
        scene = match.group(1).strip()
        scene = re.sub(r"([\u4e00-\u9fff])([A-Za-z0-9])", r"\1 \2", scene)
        scene = re.sub(r"([A-Za-z0-9])([\u4e00-\u9fff])", r"\1 \2", scene)
        return f"适合{scene}场景"
    return summary.replace("VastNext 翻译专家", "翻译").strip().rstrip("。")


def load_catalog(source: Path) -> tuple[list[dict], dict[str, str]]:
    catalog: list[dict] = []
    prompts: dict[str, str] = {}
    source_files = sorted(
        (source / "experts").glob("*.yaml"),
        key=lambda path: (DISPLAY_ORDER_INDEX.get(path.stem, len(DISPLAY_ORDER)), path.stem),
    )
    for path in source_files:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        expert_id = data["id"]
        locale = data["metadata"]["locale"]["zh-CN"]
        catalog.append({
            "id": expert_id,
            "name": DISPLAY_NAMES.get(expert_id, locale["name"]),
            "description": DISPLAY_DESCRIPTIONS.get(expert_id, display_description(locale["summary"])),
            "version": data["version"],
        })
        prompts[expert_id] = semantic_prompt(data)
    if len(catalog) != 29:
        raise ValueError(f"Expected 29 experts, found {len(catalog)}.")
    return catalog, prompts


def generated_typescript(catalog: list[dict], revision: str) -> str:
    payload = json.dumps(catalog, ensure_ascii=False, indent=2)
    return (
        "// Generated by scripts/sync-experts.py. Do not edit manually.\n"
        f"export const EXPERT_CATALOG_REVISION = {json.dumps(revision)};\n"
        f"export const BUILTIN_EXPERT_CATALOG = {payload} as const;\n"
    )


def write_or_check(path: Path, content: str, check: bool) -> bool:
    current = path.read_text(encoding="utf-8") if path.exists() else ""
    if current == content:
        return True
    if check:
        print(f"Generated expert snapshot is stale: {path.relative_to(ROOT)}", file=sys.stderr)
        return False
    path.write_text(content, encoding="utf-8", newline="\n")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the Chrome extension expert snapshot from LexiLayerPrompts.")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    source = args.source.resolve()
    if not (source / "experts").is_dir():
        print(f"Expert repository not found: {source}", file=sys.stderr)
        return 1
    try:
        revision = source_revision(source)
        catalog, prompts = load_catalog(source)
    except (subprocess.CalledProcessError, ValueError, KeyError, yaml.YAMLError) as error:
        print(str(error), file=sys.stderr)
        return 1
    prompt_payload = {
        "source": "https://github.com/VastNext/LexiLayerPrompts",
        "revision": revision,
        "prompts": prompts,
    }
    outputs = [
        write_or_check(ROOT / "src/shared/builtin-experts.generated.ts", generated_typescript(catalog, revision), args.check),
        write_or_check(ROOT / "public/experts.json", json.dumps(prompt_payload, ensure_ascii=False, separators=(",", ":")) + "\n", args.check),
        write_or_check(ROOT / "public/EXPERTS-NOTICE.txt", (
            "VastNext Expert Prompts\n"
            "Copyright 2026 VastNext 瀚海未来科技.\n"
            "Source: https://github.com/VastNext/LexiLayerPrompts\n"
            f"Snapshot revision: {revision}\n"
            "Expert prompt content is licensed under CC BY 4.0.\n"
        ), args.check),
    ]
    if all(outputs):
        print(f"Synchronized {len(catalog)} experts from {revision[:12]}.")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
