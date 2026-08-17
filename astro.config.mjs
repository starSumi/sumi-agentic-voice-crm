import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sumiDocsPublisher from "./integrations/sumi-docs-publisher.mjs";

const site = process.env.DOCS_SITE_URL || "http://127.0.0.1:4321";

const englishDocuments = [
  ["index.md", "index.md", "/"],
  ["QUICKSTART.md", "quickstart.md", "/quickstart/"],
  ["CONFIGURATION.md", "configuration.md", "/configuration/"],
  ["API.md", "api.md", "/api/"],
  ["ARCHITECTURE.md", "architecture.md", "/architecture/"],
  ["DATA-MODEL.md", "data-model.md", "/data-model/"],
  ["LIFECYCLE.md", "lifecycle.md", "/lifecycle/"],
  ["EVENTS-AUDIT.md", "events-audit.md", "/events-audit/"],
  ["SECURITY.md", "security.md", "/security/"],
  ["OPERATIONS.md", "operations.md", "/operations/"],
  ["DEVELOPMENT.md", "development.md", "/development/"],
  ["CONTRIBUTING.md", "contributing.md", "/contributing/"],
  ["BUILD-RELEASE.md", "build-release.md", "/build-release/"],
  ["TRACEABILITY.md", "traceability.md", "/traceability/"],
  [
    "ADR-0001-agentic-crm.md",
    "adr-0001-agentic-crm.md",
    "/adr-0001-agentic-crm/",
  ],
  [
    "ADR-0004-runtime-agent-boundary.md",
    "adr-0004-runtime-agent-boundary.md",
    "/adr-0004-runtime-agent-boundary/",
  ],
  ["TROUBLESHOOTING.md", "troubleshooting.md", "/troubleshooting/"],
  ["LOCALIZATION.md", "localization.md", "/localization/"],
];

const chineseDocuments = [
  ["index.md", "/zh-cn/"],
  ["quickstart.md", "/zh-cn/quickstart/"],
  ["configuration.md", "/zh-cn/configuration/"],
  ["api.md", "/zh-cn/api/"],
  ["architecture.md", "/zh-cn/architecture/"],
  ["security.md", "/zh-cn/security/"],
  ["operations.md", "/zh-cn/operations/"],
  ["development.md", "/zh-cn/development/"],
  ["contributing.md", "/zh-cn/contributing/"],
  ["troubleshooting.md", "/zh-cn/troubleshooting/"],
  ["localization.md", "/zh-cn/localization/"],
  ["adr-0001-agentic-crm.md", "/zh-cn/adr-0001-agentic-crm/"],
  ["adr-0004-runtime-agent-boundary.md", "/zh-cn/adr-0004-runtime-agent-boundary/"],
];

const documents = [
  ...englishDocuments.map(([source, machine, page]) => ({
    source,
    machine,
    page,
  })),
  ...chineseDocuments.map(([source, page]) => ({
    source: `zh-cn/${source}`,
    machine: `zh-cn/${source}`,
    page,
  })),
];

export default defineConfig({
  site,
  outDir: "./artifacts/docs-site",
  integrations: [
    starlight({
      title: {
        en: "Sumi Agentic Voice CRM",
        "zh-CN": "Sumi 智能语音 CRM",
      },
      description:
        "Contract-first documentation for the Sumi Agentic Voice CRM reference platform.",
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        "zh-cn": { label: "简体中文", lang: "zh-CN" },
      },
      logo: {
        src: "./src/assets/sumi-docs-mark.png",
        alt: "Sumi Docs",
      },
      editLink: {
        baseUrl:
          "https://github.com/starSumi/sumi-agentic-voice-crm/edit/main/",
      },
      expressiveCode: {
        themes: ["starlight-dark", "starlight-light"],
        useStarlightDarkModeSwitch: true,
      },
      customCss: ["./src/styles/docs.css"],
      sidebar: [
        {
          label: "Start here",
          translations: { "zh-CN": "从这里开始" },
          items: [
            { slug: "index", label: "Overview", translations: { "zh-CN": "概览" } },
            { slug: "quickstart", label: "Quickstart", translations: { "zh-CN": "快速开始" } },
            { slug: "configuration", label: "Configuration", translations: { "zh-CN": "配置" } },
            { slug: "api", label: "API contract", translations: { "zh-CN": "API 契约" } },
            { slug: "troubleshooting", label: "Troubleshooting", translations: { "zh-CN": "故障排查" } },
          ],
        },
        {
          label: "Design and safety",
          translations: { "zh-CN": "设计与安全" },
          items: [
            { slug: "architecture", label: "Architecture", translations: { "zh-CN": "架构" } },
            { slug: "data-model", label: "Data model", translations: { "zh-CN": "数据模型" } },
            { slug: "lifecycle", label: "Lifecycle", translations: { "zh-CN": "生命周期" } },
            { slug: "events-audit", label: "Events and audit", translations: { "zh-CN": "事件与审计" } },
            { slug: "security", label: "Security", translations: { "zh-CN": "安全" } },
            { slug: "adr-0001-agentic-crm", label: "ADR-0001", translations: { "zh-CN": "ADR-0001" } },
          ],
        },
        {
          label: "Operate and deliver",
          translations: { "zh-CN": "运维与交付" },
          items: [
            { slug: "operations", label: "Operations", translations: { "zh-CN": "运维" } },
            { slug: "build-release", label: "Build and release", translations: { "zh-CN": "构建与发布" } },
          ],
        },
        {
          label: "Contribute and verify",
          translations: { "zh-CN": "贡献与验证" },
          items: [
            { slug: "development", label: "Development", translations: { "zh-CN": "开发" } },
            { slug: "contributing", label: "Contributing", translations: { "zh-CN": "参与贡献" } },
            { slug: "traceability", label: "Traceability", translations: { "zh-CN": "需求追踪" } },
            { slug: "localization", label: "Localization", translations: { "zh-CN": "国际化" } },
          ],
        },
      ],
    }),
    sumiDocsPublisher({
      sourceRoot: "docs",
      documents,
      openapi: { source: "contracts/openapi.yaml", output: "openapi.json" },
    }),
  ],
});
