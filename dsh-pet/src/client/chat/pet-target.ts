import type { Pet } from '../../shared/types.ts';

/** 对话默认选当前界面上可见的宠物；手动选隐藏角色仍可查看自己的历史。 */
export function chatPetVisible(pet: Pick<Pet, 'display'>, desktop: boolean): boolean {
  return pet.display === 'both' || pet.display === (desktop ? 'desktop' : 'web');
}

/** 多宠保留当前对象；显示选择变化时，已隐藏的对象回落到可见角色。 */
export function chooseChatPetId(
  pets: readonly Pet[],
  currentId: string,
  desktop: boolean,
  followVisible = false,
): string {
  const current = pets.find((pet) => pet.id === currentId);
  if (current && (!followVisible || chatPetVisible(current, desktop))) return current.id;
  return pets.find((pet) => chatPetVisible(pet, desktop))?.id ?? current?.id ?? pets[0]?.id ?? '';
}
