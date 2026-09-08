// Netlify serverless function.
// Powers Conceptra's tutor chatbot. Takes the conversation so far, plus
// optional context from the student's most recent diagnosis, and returns
// the assistant's next reply using Google's Gemini API.

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

  const { messages, context } = payload;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing messages' }) };
  }
  if (messages.length > 40) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Conversation too long' }) };
  }

  let contextBlock = 'The student has not uploaded a test yet, so you have no specific diagnosis to reference. Help with whatever they ask generally.';
  if (context && (context.overallSummary || (context.gaps && context.gaps.length))) {
    const gapsList = (context.gaps || [])
      .map(g => `- ${g.concept}: ${g.mistake} (severity: ${g.severity})`)
      .join('\n');
    const strengthsList = (context.strengths || []).join(', ');
    contextBlock = `Here is the student's most recent test diagnosis, for context. Reference it naturally when relevant, but don't force it into every reply:
Subject: ${context.subject || 'not specified'}
Summary: ${context.overallSummary || 'n/a'}
Concept gaps found:
${gapsList || 'none'}
Strengths: ${strengthsList || 'none noted'}`;
  }

  const systemPrompt = `You are Conceptra's built-in tutor chatbot. You help school/college students with study questions — explaining concepts, working through problems step by step, and offering encouragement. Keep answers clear, simple, and appropriately short for a chat interface (a few sentences to a short paragraph, using line breaks or numbered steps for anything multi-part). Be warm and encouraging, never condescending. If the student asks something totally unrelated to learning/school, you can still help, but gently keep a helpful, tutor-like tone.

${contextBlock}`;

  // Convert our simple {role, text} messages into Gemini's format.
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.text }]
  }));

  try {
    const model = 'gemini-3.6-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: contents,
        generationConfig: {
          temperature: 0.65,
          thinkingConfig: { thinkingLevel: 'low' },
          maxOutputTokens: 600
        }
      })
    });

    const raw = await response.text();

    if (!response.ok) {
      console.error('Gemini chat API error. Status:', response.status, 'Body:', raw);
      return { statusCode: response.status, body: JSON.stringify({ error: 'Gemini API error', detail: raw }) };
    }

    const data = JSON.parse(raw);
    const candidate = data.candidates && data.candidates[0];
    const part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];
    const text = part && part.text;

    if (!text) {
      return { statusCode: 502, body: JSON.stringify({ error: 'No reply from tutor', detail: raw }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: text.trim() })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Unknown server error' }) };
  }
};
