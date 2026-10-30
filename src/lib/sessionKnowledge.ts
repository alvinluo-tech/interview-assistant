import { readData, type Resume, type Goal, type Material } from './backend';
import { authorizedKnowledge } from './knowledgeContext';
import type { MockConfig } from './mock';
/** Resolve authorization at request time, not when the mock window first mounted. */
export function currentMockKnowledge(config: MockConfig): MockConfig {
    if (!config.knowledge)
        return config;
    const current = { resume: readData<Resume[]>('resumes', []).find(item => item.id === config.knowledge?.resume?.id),
        goal: readData<Goal[]>('goals', []).find(item => item.id === config.knowledge?.goal?.id),
        materials: readData<Material[]>('materials', []).filter(item => config.knowledge?.materials.some(source => source.id === item.id)) };
    const selected = authorizedKnowledge(config.knowledge, current);
    return { ...config, knowledge: { ...config.knowledge, ...selected, materials: selected.materials || [] }, knowledgeContext: undefined, resumeSummary: undefined };
}
