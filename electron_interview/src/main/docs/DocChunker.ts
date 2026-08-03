export interface DocChunk {
  text: string
  projectId: string
  sourceFile: string
  chunkIndex: number
  tokenCount: number
}

// Approximate: ~4 chars per token for English
const CHARS_PER_TOKEN = 4
const CHUNK_SIZE = 512 * CHARS_PER_TOKEN
const CHUNK_OVERLAP = 50 * CHARS_PER_TOKEN

export class DocChunker {
  chunkMarkdown(
    content: string,
    projectId: string,
    sourceFile: string
  ): DocChunk[] {
    const sections = this.splitIntoSections(content)
    const chunks: DocChunk[] = []
    let chunkIndex = 0

    for (const section of sections) {
      const sectionChunks = this.chunkText(section, projectId, sourceFile, chunkIndex)
      chunks.push(...sectionChunks)
      chunkIndex += sectionChunks.length
    }

    return chunks
  }

  private splitIntoSections(content: string): string[] {
    const lines = content.split('\n')
    const sections: string[] = []
    let current: string[] = []

    for (const line of lines) {
      if (line.startsWith('## ') || line.startsWith('# ')) {
        if (current.length > 0) {
          sections.push(current.join('\n'))
          current = []
        }
      }
      current.push(line)
    }

    if (current.length > 0) {
      sections.push(current.join('\n'))
    }

    return sections
  }

  private chunkText(
    text: string,
    projectId: string,
    sourceFile: string,
    startIndex: number
  ): DocChunk[] {
    const chunks: DocChunk[] = []
    let start = 0

    while (start < text.length) {
      const end = Math.min(start + CHUNK_SIZE, text.length)
      const chunkText = text.slice(start, end)

      chunks.push({
        text: chunkText,
        projectId,
        sourceFile,
        chunkIndex: startIndex + chunks.length,
        tokenCount: Math.ceil(chunkText.length / CHARS_PER_TOKEN)
      })

      start = end - CHUNK_OVERLAP
      if (start < 0) start = 0
    }

    return chunks
  }
}
