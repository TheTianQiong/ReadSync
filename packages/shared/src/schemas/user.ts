import { z } from 'zod';
import { THEME_PREFERENCES } from '../constants.js';
import { dashboardLayoutSchema } from './stats.js';

/** 用户个人资料与偏好（设置页「基础设置」） */

export const updateProfileSchema = z.object({
  displayName: z.string().trim().max(64).optional(),
  email: z.email('邮箱格式不正确').optional(),
  avatarUrl: z.string().max(2048).optional(),
});

export const updatePreferencesSchema = z.object({
  theme: z.enum(THEME_PREFERENCES).optional(),
  /** 首页组件布局 */
  dashboard: dashboardLayoutSchema.optional(),
  /** 列表页每页条数 */
  pageSize: z.coerce.number().int().min(5).max(100).optional(),
  /** 时间显示用的时区，例如 Asia/Shanghai */
  timezone: z.string().max(64).optional(),
  /** 邮件通知开关 */
  emailNotifications: z.boolean().optional(),
});

export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

export interface UserPreferences {
  theme: (typeof THEME_PREFERENCES)[number];
  dashboard: z.infer<typeof dashboardLayoutSchema>;
  pageSize: number;
  timezone: string;
  emailNotifications: boolean;
}

/** 用户自定义的阅读平台（设置页「阅读平台管理」） */
export const readingPlatformSchema = z.object({
  /** 平台标识，内置平台不可修改 */
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, '标识只能包含小写字母、数字、下划线和连字符'),
  label: z.string().trim().min(1).max(64),
  /** 图标名或 emoji */
  icon: z.string().max(64).optional(),
  /** 主题色，十六进制 */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, '颜色需为 #RRGGBB 格式')
    .optional(),
});

export type ReadingPlatformInput = z.infer<typeof readingPlatformSchema>;

export interface ReadingPlatform {
  id: string;
  label: string;
  icon: string | null;
  color: string | null;
  /** 是否为内置平台 */
  builtin: boolean;
  createdAt: string;
}
