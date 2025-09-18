// import { GoogleGenerativeAI } from "@google/generative-ai";

// const apiKey: string = process.env.GEMINI_API_KEY || "";
// const genAI = new GoogleGenerativeAI(apiKey);

// function buildPrompt(text: string): string {
//   return `
// You are an assistant that summarizes nursing facility reviews into a concise, neutral "Pros & Cons" for families.
// Rules:
// - Be objective and avoid speculation.
// - Use short bullet points.
// - If reviews conflict, mention variability.

// Reviews:
// """
// ${text}
// """

// Return JSON with keys: summary (2-3 sentences), pros (array of bullets), cons (array of bullets).
// `;
// }

// export interface SummarizeResult {
//   summary: string;
//   pros: string[];
//   cons: string[];
// }

// function extractJsonOrFallback(raw: string): SummarizeResult {
//   const clean = raw.replace(/```json/gi, "").replace(/```/g, "").trim();

//   try {
//     const parsed = JSON.parse(clean);
//     return {
//       summary: parsed.summary || "",
//       pros: parsed.pros || [],
//       cons: parsed.cons || [],
//     };
//   } catch {
//     const pros: string[] = [];
//     const cons: string[] = [];

//     clean.split("\n").forEach(line => {
//       if (/^\s*[-*+]\s*/.test(line)) {
//         if (/cons?/i.test(line)) {
//           cons.push(line.replace(/^\s*[-*+]\s*/, "").trim());
//         } else {
//           pros.push(line.replace(/^\s*[-*+]\s*/, "").trim());
//         }
//       }
//     });

//     return {
//       summary: clean.substring(0, 300),
//       pros: pros.length ? pros : ["No clear pros found"],
//       cons: cons.length ? cons : ["No clear cons found"],
//     };
//   }
// }

// export async function summarizeReviews(
//   reviewsText: string = ""
// ): Promise<SummarizeResult> {
//   const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
//   const prompt = buildPrompt(reviewsText.slice(0, 12000)); // safety cap
//   const result = await model.generateContent(prompt);
//   const out = result.response.text();

//   return extractJsonOrFallback(out);
// }

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

function buildPrompt(text: string): string {
  return `
You are an assistant that summarizes nursing facility reviews into a concise, neutral "Pros & Cons" for families.
Rules:
- Be objective and avoid speculation.
- Use short bullet points.
- If reviews conflict, mention variability.

Reviews:
"""
${text}
"""

Return JSON with keys: summary (2-3 sentences), pros (array of bullets), cons (array of bullets).
`;
}

export interface SummarizeResult {
  summary: string;
  pros: string[];
  cons: string[];
}

function extractJsonOrFallback(raw: string): SummarizeResult {
  const clean = raw.replace(/```json/gi, "").replace(/```/g, "").trim();

  try {
    const parsed = JSON.parse(clean);
    return {
      summary: parsed.summary || "",
      pros: parsed.pros || [],
      cons: parsed.cons || [],
    };
  } catch {
    const pros: string[] = [];
    const cons: string[] = [];

    clean.split("\n").forEach((line) => {
      if (/^\s*[-*+]\s*/.test(line)) {
        if (/cons?/i.test(line)) {
          cons.push(line.replace(/^\s*[-*+]\s*/, "").trim());
        } else {
          pros.push(line.replace(/^\s*[-*+]\s*/, "").trim());
        }
      }
    });

    return {
      summary: clean.substring(0, 300),
      pros: pros.length ? pros : ["No clear pros found"],
      cons: cons.length ? cons : ["No clear cons found"],
    };
  }
}

export async function summarizeReviews(
  reviewsText: string = ""
): Promise<SummarizeResult> {
  const prompt = buildPrompt(reviewsText.slice(0, 12000));

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini", // or "gpt-4o" / "gpt-4-turbo"
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
  });

  const out = response.choices[0]?.message?.content || "";

  return extractJsonOrFallback(out);
}
