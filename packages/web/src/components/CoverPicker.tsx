import { ImageOff, ImagePlus, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { COVER_ACCEPT, validateCoverFile } from '../lib/cover';
import { Button } from './ui/Button';

/**
 * 封面选择器。
 *
 * 故意做成「哑组件」：它只管选文件、校验、预览，**不负责上传** ——
 * 因为在「登记/上传新书」的弹窗里书还不存在，没有 id 可传，只能先拿住
 * 文件、等建好之后再传；而在书籍详情页里书已经存在，选完立刻就能传。
 * 两种时序差别太大，把上传时机交给调用方决定更清楚。
 */
export function CoverPicker({
  /** 当前封面地址（已有的）或本地预览地址（刚选的） */
  src,
  /** 选好并通过校验的文件；file 为 null 表示用户取消了本地选择 */
  onSelect,
  /** 清空已有封面（不传则不显示「移除」） */
  onClear,
  busy = false,
  disabled = false,
  hint,
}: {
  src: string | null;
  onSelect: (file: File | null) => void;
  onClear?: () => void;
  busy?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
}): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  // 图裂了就别硬撑：外链封面被防盗链/CSP 拦掉时，用户看到的应当是一个
  // 明确的占位块，而不是浏览器那张碎图
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
  }, [src]);

  const handlePick = (file: File | undefined): void => {
    if (!file) return;
    const reason = validateCoverFile(file);
    if (reason) {
      setError(reason);
      return;
    }
    setError(null);
    onSelect(file);
  };

  /*
   * 「已经有封面」的判断用 onClear 而不是 src：详情页把大图放在别处，
   * 这里只当控制条用（src 传 null），但那时仍然要能「更换 / 移除」。
   */
  const hasCover = Boolean(onClear);

  return (
    <div className="flex items-start gap-3">
      <div className="flex h-28 w-20 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-line bg-surface-2">
        {src && !broken ? (
          <img
            src={src}
            alt="封面预览"
            className="h-full w-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <ImageOff size={18} className="text-muted" />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            icon={<ImagePlus size={13} />}
            disabled={disabled || busy}
            loading={busy}
            onClick={() => inputRef.current?.click()}
          >
            {hasCover || src ? '更换封面' : '选择封面'}
          </Button>
          {onClear ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<X size={13} />}
              disabled={disabled || busy}
              onClick={() => {
                setError(null);
                onClear();
              }}
            >
              移除
            </Button>
          ) : null}
        </div>

        <p className="font-sans text-[11px] text-muted">
          {hint ?? 'PNG / JPEG / WebP / GIF，不超过 1.5MB。图片会上传到服务器保存。'}
        </p>
        {error ? <p className="font-sans text-[11px] text-danger">{error}</p> : null}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={COVER_ACCEPT}
        className="hidden"
        onChange={(event) => {
          handlePick(event.target.files?.[0]);
          // 清空 value：同一个文件连选两次也要能触发 change
          event.target.value = '';
        }}
      />
    </div>
  );
}
