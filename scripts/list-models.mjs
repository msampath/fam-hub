#!/usr/bin/env node
// List Gemini models reachable with the current GEMINI_API_KEY.
// Usage: node scripts/list-models.mjs
import { GoogleGenAI } from '@google/genai';

const key = process.env.GEMINI_API_KEY;
if (!key) { console.error('Set GEMINI_API_KEY first.'); process.exit(1); }

const ai = new GoogleGenAI({ apiKey: key });
// ai.models.list() returns an async Pager you iterate — not an object with a `.models` array.
const pager = await ai.models.list({ config: { pageSize: 200 } });
for await (const m of pager) console.log(`${m.name}  ${m.displayName ?? ''}`);
