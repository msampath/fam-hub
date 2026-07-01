// Convert a @google/genai response schema (which uses the `Type.*` enum — uppercase strings
// like "OBJECT"/"ARRAY"/"STRING"/"NUMBER") into a plain JSON Schema (lowercase "object"/"array"/
// "string"/"number") that Ollama accepts in its `format` field for structured/constrained output.
// Recursive: walks `properties` and `items`; passes every other key (description, required, enum,
// nullable, format, …) through untouched. Used by the local-model bench and the callOllamaJSON
// path so both reuse the exact same canonical schemas the Gemini call already uses.
export function geminiSchemaToJsonSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(geminiSchemaToJsonSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  const out: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string') {
      out.type = value.toLowerCase();
    } else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([propKey, propVal]) => [propKey, geminiSchemaToJsonSchema(propVal)]),
      );
    } else if (key === 'items') {
      out.items = geminiSchemaToJsonSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
