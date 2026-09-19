/**
 * Нижняя шторка — для фильтров и выбора, которым не хватает места в строке.
 *
 * Под капотом Drawer из shadcn (vaul): он сам держит фокус внутри шторки,
 * закрывается свайпом вниз и по Esc, блокирует прокрутку списка под собой.
 * Раньше это было написано руками и половину из перечисленного не делало.
 *
 * Внешний вид обёртки оставлен прежним, чтобы места вызова не менялись.
 */
import { useEffect, type ReactNode } from 'react';

import { resetDocumentScroll } from '../lib/telegram';

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';

export function Sheet({
  title,
  description,
  onClose,
  children,
  footer,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // После закрытия шторки (и клавиатуры под ней) документ должен стоять на месте.
  useEffect(
    () => () => {
      setTimeout(resetDocumentScroll, 50);
    },
    [],
  );
  return (
    <Drawer open onOpenChange={(open) => !open && onClose()}>
      <DrawerContent className="max-w-[420px] mx-auto border-border bg-background">
        <DrawerHeader className="px-[13px] pt-1 pb-2 text-left">
          <DrawerTitle className="text-base font-bold">{title}</DrawerTitle>
          {description ? (
            <DrawerDescription className="text-[11px] leading-snug text-muted-foreground">
              {description}
            </DrawerDescription>
          ) : (
            // Drawer требует описание для доступности; когда его нет по смыслу,
            // отдаём пустое, но не выбрасываем элемент совсем.
            <DrawerDescription className="sr-only">{title}</DrawerDescription>
          )}
        </DrawerHeader>

        <div className="flex max-h-[62vh] flex-col gap-2.5 overflow-y-auto px-[13px] pb-3 [&>*]:shrink-0">
          {children}
        </div>

        {footer && <DrawerFooter className="px-[13px] pt-2.5 pb-4">{footer}</DrawerFooter>}
      </DrawerContent>
    </Drawer>
  );
}
