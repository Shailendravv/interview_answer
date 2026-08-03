import { create } from 'zustand'

export interface QAPair {
  id: string
  question: string
  answer: string
  timestamp: number
}

interface AppState {
  // Current in-flight Q&A
  currentQuestion: string
  currentAnswer: string

  // Full history (completed Q&A pairs)
  history: QAPair[]

  isListening: boolean
  status: 'idle' | 'listening' | 'processing' | 'speaking' | 'error'
  activeProjectId: string | null

  setTranscript: (text: string) => void
  appendAnswerToken: (token: string) => void
  resetAnswer: () => void
  pushToHistory: (question: string, answer: string) => void
  loadHistory: (pairs: QAPair[]) => void
  clearSession: () => void
  setIsListening: (v: boolean) => void
  setStatus: (s: AppState['status']) => void
  setActiveProjectId: (id: string | null) => void
  reset: () => void
}

let idCounter = 0

export const useAppStore = create<AppState>((set) => ({
  currentQuestion: '',
  currentAnswer: '',
  history: [],
  isListening: false,
  status: 'idle',
  activeProjectId: null,

  setTranscript: (text) => set({ currentQuestion: text }),
  appendAnswerToken: (token) =>
    set((state) => ({ currentAnswer: state.currentAnswer + token })),
  resetAnswer: () => set({ currentAnswer: '' }),
  pushToHistory: (question, answer) =>
    set((state) => ({
      history: [
        ...state.history,
        {
          id: `qa_${++idCounter}_${Date.now()}`,
          question,
          answer,
          timestamp: Date.now()
        }
      ],
      currentQuestion: '',
      currentAnswer: ''
    })),
  loadHistory: (pairs) => set({ history: pairs }),
  clearSession: () => set({ history: [], currentQuestion: '', currentAnswer: '' }),
  setIsListening: (v) => set({ isListening: v }),
  setStatus: (s) => set({ status: s }),
  setActiveProjectId: (id) => set({ activeProjectId: id }),
  reset: () =>
    set({
      currentQuestion: '',
      currentAnswer: '',
      isListening: false,
      status: 'idle'
    })
}))
