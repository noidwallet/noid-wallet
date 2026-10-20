import { LockView } from '@/components/LockView';
import { Screen } from '@/components/ui';
import { goRoot } from '@/lib/nav';

export default function Lock() {
  return (
    <Screen>
      <LockView onUnlocked={goRoot} />
    </Screen>
  );
}
