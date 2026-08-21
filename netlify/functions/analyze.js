// Netlify serverless function.
// Receives an uploaded test photo from the browser, calls Google's Gemini API
// (free tier, Flash model) using a secret key stored in Netlify environment
// variables (never exposed to the browser), and returns the diagnosis JSON.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server is missing GEMINI_API_KEY. Set it in Netlify site settings.' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { base64, mediaType, subject } = payload;
  if (!base64 || !mediaType) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing image data' }) };
  }

  // Guard against payloads too large for Netlify Functions (~6MB limit).
  const approxBytes = base64.length * 0.75;
  if (approxBytes > 5.5 * 1024 * 1024) {
    return {
      statusCode: 413,
      body: JSON.stringify({ error: 'Photo is too large even after compression. Try a smaller or less detailed photo.' })
    };
  }

  const subjectLine = subject ? `The student says this is: ${subject}.` : '';

  const prompt = `You are Conceptra, an expert, encouraging tutor who diagnoses learning gaps from a photo of a student's test, worksheet, or homework page.

STEP 1 — CHECK READABILITY FIRST.
Before doing any diagnosis, judge whether the handwriting and page are actually legible enough to grade accurately. Mark it as NOT readable if: the handwriting is illegible or too messy to make out words/numbers with confidence, the photo is too blurry or out of focus, the lighting is too dark or has harsh glare/shadows hiding parts of the writing, the page is cut off or a significant part of the answers is out of frame, or the image doesn't contain gradeable handwritten/printed academic answers at all. Be reasonably strict — if you are genuinely unsure what a meaningful portion of the answers say, mark it NOT readable rather than guessing.

STEP 2 — ONLY IF READABLE, DIAGNOSE.
Look at every question and answer visible in the image. For each mistake, identify the underlying CONCEPT the student is weak in (not just "got question 3 wrong" but the actual skill/idea behind it, e.g. "distributing a negative sign across parentheses"). Group related mistakes into the same concept gap rather than listing every single question separately. Keep language simple, plain, and encouraging — written for the student to read directly, not a teacher's report.

${subjectLine}

Respond with ONLY valid JSON matching exactly this shape:
{
  "imageQuality": {
    "readable": true or false,
    "issue": "if not readable, one short plain sentence explaining the specific problem (e.g. 'The handwriting in the bottom half is too faint to make out'); empty string if readable"
  },
  "overallSummary": "one or two encouraging sentences, in second person, summarizing the big picture — omit/empty if not readable",
  "gaps": [
    {
      "concept": "short concept name, e.g. 'Solving linear equations with negative coefficients'",
      "mistake": "one plain sentence describing what the student actually did wrong, referencing the specific question if possible",
      "whyItHappened": "one short sentence on the likely root cause of the error",
      "recommendation": "one concrete, specific, actionable thing the student should do to fix this gap (a practice type, a rule to memorize, a habit to build)",
      "severity": "high, medium, or low"
    }
  ],
  "strengths": ["short phrase describing something the student clearly did well, plain and specific"]
}

If imageQuality.readable is false, return "gaps": [] and "strengths": [] and leave overallSummary empty — do not attempt a diagnosis on text you can't confidently read. Otherwise include 2 to 5 gaps ordered by severity (high first), and 1 to 3 strengths.`;

  try {
    const model = 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mediaType, data: base64 } }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.4
        }
      })
    });

    const raw = await response.text();

    if (!response.ok) {
      return { statusCode: response.status, body: JSON.stringify({ error: 'Gemini API error', detail: raw }) };
    }

    const data = JSON.parse(raw);
    const candidate = data.candidates && data.candidates[0];
    const part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];
    const text = part && part.text;

    if (!text) {
      return { statusCode: 502, body: JSON.stringify({ error: 'No text in AI response', detail: raw }) };
    }

    let clean = text.trim()
      .replace(/^```json/i, '')
      .replace(/^```/, '')
      .replace(/```$/, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not parse AI response', raw: clean }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Unknown server error' }) };
  }
};
