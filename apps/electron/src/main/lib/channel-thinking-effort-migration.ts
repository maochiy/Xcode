import {
  normalizeConfiguredThinkingEffortLevels,
  type ChannelModel,
  type ChannelsConfig,
} from '@proma/shared'

export function normalizeChannelModelThinkingEffort(model: ChannelModel): ChannelModel {
  const levels = normalizeConfiguredThinkingEffortLevels(model.thinkingEffortLevels)
  const defaultLevel = model.defaultThinkingEffortLevel === 'max'
    ? 'xhigh'
    : model.defaultThinkingEffortLevel
  if (
    model.thinkingEffortLevels?.length === levels.length
    && levels.every((level, index) => level === model.thinkingEffortLevels?.[index])
    && defaultLevel === model.defaultThinkingEffortLevel
  ) return model

  return {
    ...model,
    thinkingEffortLevels: levels,
    ...(defaultLevel ? { defaultThinkingEffortLevel: defaultLevel } : {}),
  }
}

/** 加载时补齐旧模型并回写一次，不要求用户逐个打开模型再保存。 */
export function migrateChannelThinkingEffort(config: ChannelsConfig): ChannelsConfig {
  const channels = config.channels.map(channel => {
    const models = channel.models.map(normalizeChannelModelThinkingEffort)
    return models.every((model, index) => model === channel.models[index])
      ? channel
      : { ...channel, models }
  })
  return channels.every((channel, index) => channel === config.channels[index])
    ? config
    : { ...config, channels }
}
