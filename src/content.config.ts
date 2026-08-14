import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";

const normalizeDocumentId = (entry: string) => {
  const id = entry
    .replace(/\.md$/i, "")
    .replaceAll("\\", "/")
    .toLowerCase();
  return id.endsWith("/index") ? id.slice(0, -"/index".length) : id;
};

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: "./docs",
      pattern: "**/*.md",
      generateId: ({ entry }) => normalizeDocumentId(entry),
    }),
    schema: docsSchema({
      extend: z.object({
        docId: z.string().regex(/^crm\.[a-z0-9.-]+$/),
        locale: z.enum(["en", "zh-CN"]),
        audience: z.enum(["human", "agent", "both"]),
        contentVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
      }),
    }),
  }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
