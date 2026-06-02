import {
  DefaultMemoryRetriever,
  type EntryMemorySearchResult,
  type FactMemorySearchResult,
  type MemoryContract,
  type VectorStore,
} from "@jarvis/memory-runtime";

function inMemoryVectorStore<T>(items: T[]): VectorStore<T> {
  return {
    async search({ topK }) {
      return items.slice(0, topK).map((item, index) => ({
        item,
        score: 1 - index * 0.05,
      }));
    },
  };
}

const contract: MemoryContract = {
  needMemory: true,
  subjectBoundary: "personal",
  targetScopes: ["fact", "entry"],
  memoryTarget: "project_context",
  query: { raw: "project roadmap", entities: ["project"] },
  confidence: { subject: 1, target: 0.9, query: 0.9 },
  constraints: {
    allowPersonalFacts: true,
    allowSessionHistory: false,
    allowEntries: true,
    maxChars: 1200,
  },
  reasons: ["example_custom_store"],
  policyTrace: [],
};

const retriever = new DefaultMemoryRetriever({
  stores: {
    facts: {
      async searchFacts(query, options) {
        const results = await factVectorStore.search({
          query,
          topK: options?.limit ?? 5,
          filters: options?.contract ? { contract: options.contract } : {},
        });
        return results.map((result) => ({
          ...result.item,
          score: result.score,
        }));
      },
    },
    entries: {
      async searchEntries(query, options) {
        const results = await entryVectorStore.search({
          query,
          topK: options?.limit ?? 5,
          filters: options?.contract ? { contract: options.contract } : {},
        });
        return results.map((result) => ({
          ...result.item,
          score: result.score,
        }));
      },
    },
  },
});

const factVectorStore = inMemoryVectorStore<FactMemorySearchResult>([
  {
    id: "fact-1",
    subject: "project",
    content: "The project prioritizes runtime package extraction.",
    confidence: 0.9,
    sourceRefs: ["roadmap"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]);

const entryVectorStore = inMemoryVectorStore<EntryMemorySearchResult>([
  {
    id: "entry-1",
    kind: "decision",
    content: "Use adapter boundaries for host-specific integrations.",
    entities: ["runtime"],
    timestamp: new Date().toISOString(),
    sourceRefs: ["architecture-note"],
  },
]);

const result = await retriever.retrieve(contract);
console.log(result.facts.length, result.entries.length);
