import type { PluginConfigField } from '@readsync/shared';
import type { ReactNode } from 'react';
import { Input, Select } from './ui/Input';
import { Switch } from './ui/Switch';

/**
 * 插件配置表单的字段渲染与取值。
 *
 * 抽出来是因为同一张表单要在两个地方出现，而两处的**字段来源不同**：
 *  - 管理后台：`scope: 'site'` 的字段，管理员填一次全站共用；
 *  - 设置 → 插件：`scope: 'user'` 的字段，每个用户填自己那份。
 *
 * 渲染规则必须完全一致（条件显示、脱敏回填、数字/布尔的取值），
 * 否则同一份清单在两处会长得不一样 —— 那正是最难查的一类问题。
 */

export type FieldValues = Record<string, string | boolean>;

/**
 * 按 showWhen 挑出当前该显示的配置项。
 *
 * 「连接方式」这类配置必然需要它：选了 WebDAV 就不该看到 S3 的密钥框。
 * 没有条件显示，一个支持多驱动的插件会甩出十几个字段，大半与当前选择无关。
 */
export function visibleFields(fields: PluginConfigField[], values: FieldValues): PluginConfigField[] {
  return fields.filter((field) => {
    if (!field.showWhen) return true;
    const current = values[field.showWhen.key];
    // 比较前统一成字符串：select 的值是字符串，而 showWhen 里可能写成数字或布尔
    return String(current) === String(field.showWhen.equals);
  });
}

/** 已保存的配置 → 表单初值（脱敏字段留空，表示「不修改」） */
export function initialValues(
  fields: PluginConfigField[],
  config: Record<string, unknown>,
): FieldValues {
  const next: FieldValues = {};
  for (const field of fields) {
    const saved = config[field.key];

    if (field.type === 'boolean') {
      next[field.key] = saved === true || saved === 'true' || saved === field.default;
      continue;
    }
    // 掩码不回填：服务端把「原样提交掩码」解释为不修改，这里给空串更不容易误伤
    if (typeof saved === 'string' && /^[•*]+$/.test(saved)) {
      next[field.key] = '';
      continue;
    }
    next[field.key] = saved === undefined || saved === null ? String(field.default ?? '') : String(saved);
  }
  return next;
}

/**
 * 表单值 → 提交给接口的配置。
 *
 * 只提交当前可见的字段：条件字段（例如选了 WebDAV 时那些 S3 的框）若一并提交，
 * 会把上次填过的旧值再写回去 —— 换连接方式后配置里混着两种驱动的参数，
 * 下次切换回来时看到的就是过期的值。
 */
export function collectConfig(
  fields: PluginConfigField[],
  values: FieldValues,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of visibleFields(fields, values)) {
    const value = values[field.key];
    // 留空的可选敏感字段不提交，避免把空串写进配置
    if (value === '' && !field.required) continue;
    config[field.key] = field.type === 'number' ? Number(value) : value;
  }
  return config;
}

export function ConfigFieldControl({
  field,
  value,
  onChange,
}: {
  field: PluginConfigField;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}): ReactNode {
  if (field.type === 'boolean') {
    return <Switch checked={value === true} onChange={onChange} />;
  }

  if (field.type === 'select') {
    return (
      <Select value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>
        <option value="">请选择</option>
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  }

  return (
    <Input
      type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
      value={String(value ?? '')}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.placeholder ?? ''}
      autoComplete={field.type === 'password' ? 'new-password' : undefined}
    />
  );
}
