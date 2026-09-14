export const noisyAgentResultFixture = {
  id: "child-noisy-1",
  data: {
    worker_result: {
      requirements: [{ id: "REQ-1", statement: "Use the structured child model" }],
    },
  },
  output: [
    "worker log: started",
    JSON.stringify({ worker_result: { requirements: [{ id: "REQ-1", statement: "Do not trust stdout" }] } }),
    "worker prose: completed successfully",
  ].join("\n"),
} as const;
