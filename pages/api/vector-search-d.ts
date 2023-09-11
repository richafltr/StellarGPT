
import type { NextRequest } from 'next/server';
import { codeBlock, oneLine } from 'common-tags';
import GPT3Tokenizer from 'gpt3-tokenizer';
import {
  Configuration,
  OpenAIApi,
  CreateModerationResponse,
  CreateEmbeddingResponse,
  ChatCompletionRequestMessage,
} from 'openai-edge';
import { OpenAIStream, StreamingTextResponse } from 'ai';
import { ApplicationError, UserError } from '@/lib/errors';
import { PineconeClient } from "@pinecone-database/pinecone";
import { Vector } from "@pinecone-database/pinecone";
import { Pipeline } from "@xenova/transformers";
import { v4 as uuidv4 } from "uuid";
import { sliceIntoChunks } from "./util.js";  // Assuming util.ts is in the same directory.

const openAiKey = process.env.OPENAI_KEY;

const config = new Configuration({
  apiKey: openAiKey,
});
const openai = new OpenAIApi(config);

// Embedder class
class Embedder {
  private pipe: Pipeline | null = null;

  // Initialize the pipeline
  async init() {
    const { pipeline } = await import("@xenova/transformers");
    this.pipe = await pipeline("embeddings", "Xenova/all-MiniLM-L6-v2");
  }

  // Embed a single string
  async embed(text: string): Promise<Vector> {
    const result = this.pipe && (await this.pipe(text));
    return {
      id: uuidv4(),
      metadata: {
        text,
      },
      values: Array.from(result.data),
    };
  }

  // Batch an array of string and embed each batch
  // Call onDoneBatch with the embeddings of each batch
  async embedBatch(
    texts: string[],
    batchSize: number,
    onDoneBatch: (embeddings: Vector[]) => void
  ) {
    const batches = sliceIntoChunks<string>(texts, batchSize);
    for (const batch of batches) {
      const embeddings = await Promise.all(
        batch.map((text) => this.embed(text))
      );
      await onDoneBatch(embeddings);
    }
  }
}


// Pinecone initialization
const getPineconeClient = async (): Promise<PineconeClient> => {
  if (!process.env.PINECONE_API_KEY) {
    throw new Error("Pinecone API key is not set!");
  }
  return new PineconeClient({ apiKey: process.env.PINECONE_API_KEY });
};

let pineconeClient: PineconeClient | null = null;

const embedder = new Embedder();

export const runtime = 'edge';

export default async function handler(req: NextRequest) {
  try {
    if (!openAiKey) {
      throw new ApplicationError('Missing environment variable OPENAI_KEY');
    }

    const requestData = await req.json();
    if (!requestData) {
      throw new UserError('Missing request data');
    }

    const { prompt: query } = requestData;
    if (!query) {
      throw new UserError('Missing query in request data');
    }

    // Content moderation
 // Content moderation
    const sanitizedQuery = query.trim();
    const moderationResponse: CreateModerationResponse = await openai.createModeration({ input: sanitizedQuery }).then((res) => res.json());
    const [moderationResults] = moderationResponse.results;  // <-- Changed here
    if (moderationResults.flagged) {                         // <-- Changed here
    throw new UserError('Flagged content', {
        flagged: true,
        categories: moderationResults.categories,            // <-- Changed here
    });
    }


    // Embedding
    const embeddedQuery: Vector = await embedder.embed(sanitizedQuery);

    // Pinecone query
    if (!pineconeClient) {
        pineconeClient = await getPineconeClient();
    }
    const indexName = process.env.PINECONE_INDEX;
    const index = pineconeClient.Index(indexName);
    const results = await index.query({
        queryRequest: {
        vector: embeddedQuery.values,
        topK: 10,
        includeMetadata: true,
        includeValues: false,
        namespace: "default",
        },
    });

    const pageSections = results.matches?.map((match) => ({
      text: match.metadata?.text,
      score: match.score,
    })) || [];

    // Process results
    const tokenizer = new GPT3Tokenizer({ type: 'gpt3' });
    let tokenCount = 0;
    let contextText = '';
    for (let i = 0; i < pageSections.length; i++) {
      const content = pageSections[i].text;
      const encoded = tokenizer.encode(content);
      tokenCount += encoded.text.length;
      if (tokenCount >= 1500) {
        break;
      }
      contextText += `${content.trim()}\n---\n`;
    }

    const prompt = codeBlock`
      ${oneLine`
        You are a very enthusiastic Sorban developer relationship expert who loves
        to help people! Given the following sections from the Soroba
        documentation, answer the question using only that information,
        outputted in markdown format. If you are unsure and the answer
        is not explicitly written in the documentation, say
        "Sorry, I don't know how to help with that."
      `}

      Context sections:
      ${contextText}

      Question: """
      ${sanitizedQuery}
      """

      Answer as markdown (including related code snippets if available):
    `;

    const chatMessage: ChatCompletionRequestMessage = {
      role: 'user',
      content: prompt,
    };

    const response = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [chatMessage],
      max_tokens: 512,
      temperature: 0,
      stream: true,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new ApplicationError('Failed to generate completion', error);
    }

    // Transform the response
    const stream = OpenAIStream(response);
    return new StreamingTextResponse(stream);
  } catch (err: unknown) {
    if (err instanceof UserError) {
      return new Response(
        JSON.stringify({
          error: err.message,
          data: err.data,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } else if (err instanceof ApplicationError) {
      console.error(`${err.message}: ${JSON.stringify(err.data)}`);
    } else {
      console.error(err);
    }

    return new Response(
      JSON.stringify({
        error: 'There was an error processing your request',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

export { embedder };
