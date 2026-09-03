/** Position closes always attempt to return every withdrawn ERC-20 side to native ETH. */
export function closeTokenPolicy(_legacySetting: boolean): boolean {
  return true;
}
