import { pipeline, env } from "@huggingface/transformers"

env.allowLocalModels = false

type ExtractorFn = (text: string | string[], options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array | number[]; dims?: number[] }>

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2"

let modelOverride: string | null = null
let extractorPromise: Promise<ExtractorFn> | null = null
let extractorModel: string | null = null

export function configureEmbedding(model: string): void {
  if (model && model !== modelOverride) {
    modelOverride = model
    extractorPromise = null
    extractorModel = null
  }
}

function getExtractor() {
  const model = modelOverride ?? DEFAULT_MODEL
  if (!extractorPromise || extractorModel !== model) {
    extractorPromise = pipeline("feature-extraction", model) as unknown as Promise<ExtractorFn>
    extractorModel = model
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
