import { pipeline, env } from "@huggingface/transformers"

env.allowLocalModels = false

type ExtractorFn = (text: string | string[], options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array | number[]; dims?: number[] }>

let extractorPromise: Promise<ExtractorFn> | null = null

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2") as unknown as Promise<ExtractorFn>
  }
  return extractorPromise
}

export async function embed(text: string): Promise<Float32Array> {
  const extractor = await getExtractor()
  const output = await extractor(text, { pooling: "mean", normalize: true })
  return new Float32Array(output.data)
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  const extractor = await getExtractor()
  const output = await extractor(texts, { pooling: "mean", normalize: true })
  const dims = output.dims![output.dims!.length - 1]
  const data = new Float32Array(output.data)
  const result: Float32Array[] = []
  for (let i = 0; i < texts.length; i++) {
    result.push(data.slice(i * dims, (i + 1) * dims))
  }
  return result
}
