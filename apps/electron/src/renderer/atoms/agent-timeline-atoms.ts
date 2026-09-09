import { atom } from 'jotai'

/** 仅保存界面展开选择，不参与原生消息顺序或持久化。 */
export const agentTimelineExpandedAtom = atom(new Map<string, boolean>())

export function createTimelineExpansionAtom(key: string) {
  return atom(
    (get) => get(agentTimelineExpandedAtom).get(key),
    (get, set, value: boolean) => {
      set(agentTimelineExpandedAtom, new Map(get(agentTimelineExpandedAtom)).set(key, value))
    },
  )
}
