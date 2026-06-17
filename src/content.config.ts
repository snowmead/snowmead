import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// Blog posts live in src/content/blog as Markdown files. The glob loader (Content
// Layer API) derives a URL-friendly id from each filename.
const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    // Social auto-posting (scripts/x-post.mjs). All optional:
    //   tweet: false      -> never announce this post on X
    //   tweetText         -> override the auto-composed announcement text
    //   tweetUpdate       -> when set/changed, thread an "Updated" reply on X
    tweet: z.boolean().default(true),
    tweetText: z.string().optional(),
    tweetUpdate: z.string().optional(),
  }),
});

export const collections = { blog };
