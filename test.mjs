import "dotenv/config";
import Groq from "groq-sdk";

if (!process.env.GROQ_API_KEY) {
  console.error("ERROR: GROQ_API_KEY is missing from the .env file.");
  process.exit(1);
}

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

try {
  const response = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    temperature: 0,
    messages: [
      {
        role: "user",
        content: "Reply with exactly: Groq API is connected.",
      },
    ],
  });

  console.log(response.choices[0].message.content);
} catch (error) {
  console.error("Groq connection failed:");
  console.error(error);
}