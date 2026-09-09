/** Подтверждение необратимого действия — например, закрытия позиции. */
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { haptic } from '../lib/telegram';

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Drawer open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DrawerContent className="max-w-[420px] mx-auto border-border bg-background">
        <DrawerHeader className="px-[13px] text-left">
          <DrawerTitle className="text-base font-bold">{title}</DrawerTitle>
          <DrawerDescription className="text-[12.5px] leading-relaxed text-muted-foreground">
            {message}
          </DrawerDescription>
        </DrawerHeader>

        <DrawerFooter className="grid grid-cols-2 gap-2 px-[13px] pb-4">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t('app.cancel')}
          </Button>
          <Button
            variant={danger ? 'destructive' : 'default'}
            disabled={busy}
            onClick={() => {
              haptic('warning');
              onConfirm();
            }}
          >
            {busy ? t('app.working') : confirmLabel}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
