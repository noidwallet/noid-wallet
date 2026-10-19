import { Redirect } from 'expo-router';
import { useWallet } from '@/state/wallet';

export default function Index() {
  const { meta, locked } = useWallet();
  if (!meta) return <Redirect href="/welcome" />;
  return <Redirect href={locked ? '/lock' : '/home'} />;
}
