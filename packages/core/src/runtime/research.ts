/**
 * performResearch — shared Perplexity/OpenRouter research helper.
 *
 * Used by both PiMonoRunner (in-process) and agent-runtime containers.
 * Makes a direct HTTPS call to OpenRouter using the Perplexity sonar model
 * family and returns the synthesized answer with citations.
 */
import https from 'node:https';

const FOCUS_PROMPTS: Record<string, string> = {
  finance:
    'You are a financial research analyst. Provide precise, data-driven answers with specific numbers, valuations, multiples, and market data. Cite sources.',
  marketing:
    'You are a marketing research analyst. Focus on market positioning, competitor messaging, channel benchmarks, and campaign performance data. Cite sources.',
  technical:
    'You are a technical research analyst. Focus on documentation, best practices, library comparisons, security advisories, and engineering standards. Cite sources.',
  market:
    'You are a market research analyst. Provide TAM/SAM analysis, competitive landscapes, growth trends, and industry dynamics. Cite sources.',
  news:
    'You are a news research analyst. Surface the most recent and relevant developments, announcements, and breaking news on this topic. Cite sources.',
  general:
    'You are a research analyst. Provide thorough, accurate, well-structured answers with cited sources.',
};

export async function performResearch(
  query: string,
  focus: string = 'general',
  model: string = 'perplexity/sonar-pro',
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return 'Error: OPENROUTER_API_KEY is not set. Cannot perform research.';
  }

  const systemPrompt = FOCUS_PROMPTS[focus] ?? FOCUS_PROMPTS.general;

  const requestBody = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query },
    ],
  });

  return new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://djinnbot.ai',
          'X-Title': 'DjinnBot Research Tool',
          'Content-Length': Buffer.byteLength(requestBody),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              resolve(`Research error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
              return;
            }
            const content = parsed.choices?.[0]?.message?.content;
            if (!content) {
              resolve(`Research returned no content. Raw response: ${data.slice(0, 500)}`);
              return;
            }
            const citations: string[] = parsed.citations || [];
            let output = content;
            if (citations.length > 0) {
              output +=
                '\n\n---\n**Sources:**\n' +
                citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join('\n');
            }
            resolve(output);
          } catch (e) {
            resolve(`Failed to parse research response: ${e}`);
          }
        });
        res.on('error', reject);
      },
    );

    if (signal) {
      signal.addEventListener('abort', () => req.destroy(), { once: true });
    }

    req.on('error', reject);
    req.write(requestBody);
    req.end();
  });
}
