import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  ".github/CODEOWNERS",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/documentation.yml",
  ".github/pull_request_template.md",
  ".github/release.yml",
  ".github/labeler.yml",
  ".github/workflows/labeler.yml",
  ".github/workflows/pr-policy.yml",
  ".github/workflows/dependency-review.yml",
  ".github/DISCUSSION_TEMPLATE/q-and-a.yml",
  ".github/DISCUSSION_TEMPLATE/ideas.yml",
  ".github/DISCUSSION_TEMPLATE/show-and-tell.yml",
  "CODE_OF_CONDUCT.md",
  "CODE_OF_CONDUCT.zh-CN.md",
  "CONTRIBUTING.md",
  "CONTRIBUTING.zh-CN.md",
  "GOVERNANCE.md",
  "GOVERNANCE.zh-CN.md",
  "SECURITY.md",
  "SECURITY.zh-CN.md",
  "SUPPORT.md",
  "SUPPORT.zh-CN.md",
  "docs/maintaining.md",
  "docs/maintaining.zh-CN.md",
  "docs/releasing.md",
];

const failures = [];

for (const file of requiredFiles) {
  try {
    await access(file);
  } catch {
    failures.push(`missing required governance file: ${file}`);
  }
}

const checks = {
  ".github/ISSUE_TEMPLATE/config.yml": [
    "blank_issues_enabled: false",
    "/security/advisories/new",
    "/discussions/categories/q-a",
  ],
  ".github/ISSUE_TEMPLATE/bug_report.yml": [
    "type:bug",
    "status:needs-triage",
    "Sanitized output",
  ],
  ".github/ISSUE_TEMPLATE/feature_request.yml": [
    "type:feature",
    "status:needs-triage",
    "User problem",
  ],
  ".github/ISSUE_TEMPLATE/documentation.yml": [
    "type:docs",
    "status:needs-triage",
    "Language / 语言",
  ],
  ".github/pull_request_template.md": [
    "pnpm check",
    "Security and privacy impact",
    "CHANGELOG.md",
  ],
  ".github/workflows/labeler.yml": [
    "pull_request_target:",
    "pull-requests: write",
    "actions/labeler@v6",
  ],
  ".github/workflows/pr-policy.yml": [
    "pull_request_target:",
    "PR_TITLE:",
    "Allowed types:",
  ],
  ".github/workflows/dependency-review.yml": [
    "pull_request:",
    "actions/dependency-review-action@v4",
    "fail-on-severity: high",
  ],
  ".github/release.yml": [
    "Breaking changes / 破坏性变更",
    "Security / 安全",
    "skip-changelog",
  ],
  "README.md": ["[Support](SUPPORT.md)", "[Governance](GOVERNANCE.md)"],
  "README.zh-CN.md": [
    "[支持](SUPPORT.zh-CN.md)",
    "[治理](GOVERNANCE.zh-CN.md)",
  ],
  "CONTRIBUTING.md": ["[简体中文](CONTRIBUTING.zh-CN.md)"],
  "CONTRIBUTING.zh-CN.md": ["[English](CONTRIBUTING.md)"],
  "SECURITY.md": ["[简体中文](SECURITY.zh-CN.md)"],
  "SECURITY.zh-CN.md": ["[English](SECURITY.md)"],
  "SUPPORT.md": ["Response targets", "Private security advisory"],
  "SUPPORT.zh-CN.md": ["响应目标", "私密安全公告"],
  "GOVERNANCE.md": ["Decision process", "Pull request policy"],
  "GOVERNANCE.zh-CN.md": ["决策流程", "PR 规则"],
  "CHANGELOG.md": ["## Unreleased"],
  "docs/releasing.md": ["generate the GitHub Release Notes draft"],
};

for (const [file, requiredText] of Object.entries(checks)) {
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch {
    if (!requiredFiles.includes(file)) {
      failures.push(`cannot read governance file: ${file}`);
    }
    continue;
  }
  for (const text of requiredText) {
    if (!content.includes(text)) {
      failures.push(`${file} must contain ${JSON.stringify(text)}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`repository governance check passed (${requiredFiles.length} required files)`);
}
