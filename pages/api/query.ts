import { embedder } from "./embeddings.ts";
import { getPineconeClient } from "./pinecone.ts";
import { getEnv, validateEnvironmentVariables } from "./util.ts";

export const query = async (query: string, topK: number = 3) => {
  const indexName = "soroban-docs";
  
  validateEnvironmentVariables();
  const pineconeClient = await getPineconeClient();

  // Get the Pinecone index
  const index = pineconeClient.Index(indexName);
  console.log(query)

  // Embed the query using the OpenAI-based embedder
  const queryEmbedding = await embedder.embed(query);

  // Query the Pinecone index
  const results = await index.query({
    queryRequest: {
      vector: queryEmbedding.values,
      topK,
      includeMetadata: true,
      includeValues: false,
      namespace: "default",
    },
  });

  return results.matches?.map((match) => ({
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    text: match.metadata?.text,
    score: match.score,
  }));
};