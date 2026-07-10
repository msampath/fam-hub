#!/usr/bin/env node
// List Gemini models reachable with the current GEMINI_API_KEY.
// Usage: node scripts/list-models.mjs
import { GoogleGenAI } from '@google/genai';

const key = process.env.GEMINI_API_KEY;
if (!key) { console.error('Set GEMINI_API_KEY first.'); process.exit(1); }

const ai = new GoogleGenAI({ apiKey: key });
const { models } = await ai.models.list({ config: { pageSize: 200 } });
for (const m of models) console.log(`${m.name}  ${m.displayName ?? ''}`);
