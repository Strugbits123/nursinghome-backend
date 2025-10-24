import OpenAI from "openai";
import { getCache, setCache } from "../config/redisClient";
import crypto from "crypto";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

// Cost tracking
let aiUsageStats = {
  totalCalls: 0,
  cacheHits: 0,
  cacheMisses: 0,
  totalTokensUsed: 0,
  estimatedCost: 0,
};

// Cache TTL for AI summaries (7 days - reviews don't change often)
const AI_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function trackAiUsage(tokensUsed: number, cacheHit: boolean = false): void {
  aiUsageStats.totalCalls++;
  if (cacheHit) {
    aiUsageStats.cacheHits++;
  } else {
    aiUsageStats.cacheMisses++;
    aiUsageStats.totalTokensUsed += tokensUsed;
    // GPT-4o-mini pricing: $0.00015 per 1K input tokens, $0.0006 per 1K output tokens
    // Rough estimate: assume 70% input, 30% output tokens
    const inputTokens = tokensUsed * 0.7;
    const outputTokens = tokensUsed * 0.3;
    const cost = (inputTokens / 1000) * 0.00015 + (outputTokens / 1000) * 0.0006;
    aiUsageStats.estimatedCost += cost;
  }
}

export function getAiUsageStats() {
  return {
    ...aiUsageStats,
    cacheHitRate: aiUsageStats.totalCalls > 0 
      ? (aiUsageStats.cacheHits / aiUsageStats.totalCalls * 100).toFixed(2) + '%'
      : '0%',
  };
}

export function resetAiUsageStats() {
  aiUsageStats = {
    totalCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    totalTokensUsed: 0,
    estimatedCost: 0,
  };
}

function preprocessReviewsText(text: string): string {
  // Remove excessive whitespace and normalize
  let processed = text
    .replace(/\s+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
  
  // Remove very short reviews (likely spam or unhelpful)
  const reviews = processed.split('\n').filter(review => 
    review.trim().length > 20 && 
    !review.toLowerCase().includes('test') &&
    !review.toLowerCase().includes('spam')
  );
  
  // Limit to most recent/relevant reviews to reduce token usage
  const maxReviews = 15;
  const limitedReviews = reviews.slice(0, maxReviews);
  
  return limitedReviews.join('\n');
}

function buildPrompt(text: string): string {
  return `Summarize nursing facility reviews into concise "Pros & Cons" for families.
Rules: Be objective, use short bullets, mention conflicts if reviews vary.

Reviews:
"""
${text}
"""

Return JSON: {summary: "2-3 sentences", pros: ["bullet1", "bullet2"], cons: ["bullet1", "bullet2"]}`;
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

function generateCacheKey(reviewsText: string): string {
  const hash = crypto.createHash('sha256').update(reviewsText).digest('hex');
  return `ai:summary:${hash}`;
}

function selectOptimalModel(textLength: number): string {
  // Use cheaper model for shorter texts, more capable model for complex cases
  if (textLength < 2000) {
    return "gpt-3.5-turbo"; // Cheaper for simple cases
  } else if (textLength < 8000) {
    return "gpt-4o-mini"; // Good balance
  } else {
    return "gpt-4o-mini"; // Keep using mini for cost efficiency
  }
}

export async function summarizeReviews(
  reviewsText: string = ""
): Promise<SummarizeResult> {
  // 1. Preprocess text to reduce tokens
  const processedText = preprocessReviewsText(reviewsText);
  
  // 2. Generate cache key
  const cacheKey = generateCacheKey(processedText);
  
  // 3. Check cache first
  try {
    const cached = await getCache(cacheKey);
    if (cached) {
      trackAiUsage(0, true); // Cache hit
      return JSON.parse(cached);
    }
  } catch (error) {
    console.warn('Cache read error:', error);
  }

  // 4. Limit text length to control costs
  const limitedText = processedText.slice(0, 8000); // Reduced from 12000
  const prompt = buildPrompt(limitedText);
  
  // 5. Select optimal model based on complexity
  const model = selectOptimalModel(limitedText.length);

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 500, // Limit output tokens to control costs
    });

    const out = response.choices[0]?.message?.content || "";
    const tokensUsed = response.usage?.total_tokens || 0;
    
    // Track usage
    trackAiUsage(tokensUsed, false);
    
    const result = extractJsonOrFallback(out);
    
    // 6. Cache the result
    try {
      await setCache(cacheKey, JSON.stringify(result), AI_CACHE_TTL_SECONDS);
    } catch (error) {
      console.warn('Cache write error:', error);
    }
    
    return result;
  } catch (error) {
    console.error('OpenAI API error:', error);
    // Return fallback result
    return {
      summary: "Unable to generate summary at this time.",
      pros: ["Service temporarily unavailable"],
      cons: ["AI summary generation failed"],
    };
  }
}

// Batch processing for multiple facilities
export async function summarizeReviewsBatch(
  reviewsTexts: string[]
): Promise<SummarizeResult[]> {
  const results: SummarizeResult[] = [];
  
  // Process in batches to avoid rate limits
  const batchSize = 5;
  for (let i = 0; i < reviewsTexts.length; i += batchSize) {
    const batch = reviewsTexts.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(text => summarizeReviews(text))
    );
    results.push(...batchResults);
    
    // Small delay between batches to respect rate limits
    if (i + batchSize < reviewsTexts.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  return results;
}
