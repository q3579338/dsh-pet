/** 独立构建仅使用宿主 UI 的类型位置，实际界面继续使用原来的独立降级分支。 */
import type { ComponentType, SVGProps } from 'react';

/** 原图标组件使用的标准 SVG 属性。 */
export type IconProps = SVGProps<SVGSVGElement> & { size?: number | string };
/** 独立模式不注入这些组件；声明仅供类型检查，不进入运行产物。 */
export declare const Modal: unknown;
/** 宿主可选按钮组件。 */
export declare const Button: unknown;
/** 宿主可选图片灯箱。 */
export declare const ImageLightbox: unknown;
/** 宿主菜单图标仅作类型位置，不参与独立版运行。 */
export declare const IconQueueOutlineRegular: ComponentType<IconProps>;
/** 宿主多人菜单图标。 */
export declare const IconUsersOutlineRegular: ComponentType<IconProps>;
/** 宿主用量菜单图标。 */
export declare const IconGaugeOutlineRegular: ComponentType<IconProps>;
/** 宿主设置菜单图标。 */
export declare const IconSlidersTwoOutlineMedium: ComponentType<IconProps>;
