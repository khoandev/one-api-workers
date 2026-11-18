export const DUPLICATE_CHANNEL_KEY_SUFFIX = '-copy'

export const buildDuplicateChannelKey = (sourceKey: string, existingKeys: Iterable<string>): string => {
  const takenKeys = new Set(existingKeys)
  let candidate = `${sourceKey}${DUPLICATE_CHANNEL_KEY_SUFFIX}`
  let index = 2

  while (takenKeys.has(candidate)) {
    candidate = `${sourceKey}${DUPLICATE_CHANNEL_KEY_SUFFIX}-${index}`
    index += 1
  }

  return candidate
}
