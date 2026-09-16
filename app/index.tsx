import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
// The root export deprecated the function-style API in SDK 57 and now throws a
// migration error instead of saving; the legacy entry point still works.
import * as MediaLibrary from 'expo-media-library/legacy';
import { AudioLines, Gauge, ShieldCheck, Sparkles, Share2, Save, Waves } from 'lucide-react-native';
import { useAudioStore, FREE_SECONDS } from '../src/store/useAudioStore';
import { enhance } from '../src/engine/enhanceChain';
import { codec, toMono, fromMono } from '../modules/audio-codec';
import { useTheme } from '../src/theme/useTheme';
import { useTabletColumn } from '../src/theme/useTabletColumn';
import { t } from '../src/i18n';
import { ForwardArrow } from '../src/components/DirectionalIcons';
import { AdBanner } from '../src/components/AdBanner';
import { useAdsStore } from '../src/store/adsStore';
import { showInterstitial, showPrivacyOptionsForm } from '../src/services/ads';
import { shouldShowInterstitial } from '../src/services/adPolicy';

const formatDuration = (seconds: number) => {
  const whole = Math.round(seconds);
  if (whole < 60) return t('secondsShort', { seconds: whole });
  return t('minutesShort', { minutes: Math.floor(whole / 60), seconds: whole % 60 });
};

const formatDb = (value: number) =>
  Number.isFinite(value) ? value.toFixed(1) : '--';

export default function HomeScreen() {
  // Google requires a persistent entry back into the consent form wherever UMP reports that
  // privacy options are available, which in practice means the EEA and the regulated US
  // states. It is absent everywhere else rather than shown as a dead control.
  const offerPrivacyOptions = useAdsStore((state) => state.consent.offerPrivacyOptions);
  const theme = useTheme();
  const tabletColumn = useTabletColumn();
  const {
    source, samples, report, outputUri, settings, stage, isPro,
    setSource, setResult, setStage, overFreeLimit,
  } = useAudioStore();
  const [busy, setBusy] = useState(false);

  const handlePick = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const picked = await DocumentPicker.getDocumentAsync({
      type: 'audio/*',
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (picked.canceled || !picked.assets?.length) return;

    const asset = picked.assets[0];
    setStage('decoding');
    try {
      const decoded = await codec.decode(asset.uri);
      setSource(
        {
          uri: asset.uri,
          name: asset.name ?? 'recording',
          sampleRate: decoded.sampleRate,
          channels: decoded.channels,
          duration: decoded.duration,
        },
        // Mixed to mono here rather than at export: the cleanup is a voice
        // chain, and running it per channel on a stereo recording of one person
        // speaking doubles the work to produce the same result.
        toMono(decoded),
      );
    } catch (error) {
      setStage('idle');
      const message = error instanceof Error ? error.message : String(error);
      Alert.alert(
        message.includes('no audio') ? t('noAudioTitle') : t('fileUnreadable'),
        message.includes('no audio') ? t('noAudioDesc') : t('fileUnreadableDesc'),
      );
    }
  }, [setSource, setStage]);

  const handleClean = useCallback(async () => {
    if (!source || !samples) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setBusy(true);
    setStage('cleaning');
    try {
      // Cleaned on a copy so a second run starts from the original. Running the
      // chain twice over its own output compresses and lifts what it already
      // compressed and lifted, which sounds progressively worse.
      const working = Float32Array.from(
        isPro ? samples : samples.subarray(0, Math.min(samples.length, FREE_SECONDS * source.sampleRate)),
      );
      const result = enhance(working, source.sampleRate, settings);

      setStage('encoding');
      const encoded = await codec.encode(fromMono(working), source.sampleRate, 1);
      setResult(result, encoded.uri);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      setStage('idle');
      Alert.alert(t('cleanFailed'), error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [isPro, samples, setResult, setStage, settings, source]);

  /**
   * Puts the cleaned file somewhere the user can actually find it.
   *
   * The two platforms disagree about where that is. On iOS the app's Documents
   * folder is the Files app -- the app declares file sharing, so it shows up
   * under "On My iPhone". On Android Files does not show app storage at all, so
   * the file goes into the shared music library instead.
   */
  const maybeShowInterstitial = useCallback(async () => {
    const { completions, lastInterstitialAt, markInterstitialShown } = useAdsStore.getState();
    const decision = shouldShowInterstitial({
      completions,
      lastInterstitialAt,
      now: Date.now(),
      // Read at call time rather than captured: the user may have bought the upgrade from the
      // paywall between opening this screen and finishing the work.
      isPro: useAudioStore.getState().isPro,
    });
    if (!decision) return;
    // Only a shown-and-dismissed ad resets the clock. Counting an unfilled request would
    // suppress the next several ads for nothing.
    if (await showInterstitial()) await markInterstitialShown();
  }, []);

  const handleSave = useCallback(async () => {
    if (!outputUri || !source) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const name = `${source.name.replace(/\.[^.]+$/, '')}-voicecrisp.m4a`;
      if (Platform.OS === 'android') {
        const permission = await MediaLibrary.requestPermissionsAsync();
        if (!permission.granted) {
          Alert.alert(t('saveFailed'), t('savedDesc'));
          return;
        }
        await MediaLibrary.createAssetAsync(outputUri);
      } else {
        const destination = `${FileSystem.documentDirectory}${name}`;
        await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined);
        await FileSystem.copyAsync({ from: outputUri, to: destination });
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await useAdsStore.getState().recordCompletion();
      // The ad waits behind the confirmation. Interrupting the moment the file lands -- or
      // worse, while it is being written -- is the version of this that gets one-star reviews.
      Alert.alert(t('saved'), t('savedDesc'), [
        { text: t('ok'), onPress: () => void maybeShowInterstitial() },
      ]);
    } catch (error) {
      Alert.alert(t('saveFailed'), error instanceof Error ? error.message : String(error));
    }
  }, [outputUri, source]);

  const handleShare = useCallback(async () => {
    if (!outputUri) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert(t('saveFailed'), t('savedDesc'));
        return;
      }
      await Sharing.shareAsync(outputUri, { mimeType: 'audio/mp4', UTI: 'public.mpeg-4-audio' });
    } catch (error) {
      Alert.alert(t('saveFailed'), error instanceof Error ? error.message : String(error));
    }
  }, [outputUri]);

  const stageLabel =
    stage === 'decoding' ? t('decoding') : stage === 'cleaning' ? t('cleaning') : stage === 'encoding' ? t('encoding') : null;

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 px-5" style={{ backgroundColor: theme.background }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 , ...tabletColumn}}>
        <View className="mt-4 mb-5">
          <View
            className="self-start border px-3 py-1 rounded-full mb-3 flex-row items-center"
            style={{ backgroundColor: theme.primaryLight, borderColor: theme.primaryBorder }}
          >
            <Sparkles size={12} color={theme.primary} />
            <Text className="text-xs font-semibold ml-1.5" style={{ color: theme.primary }}>
              {t('heroBadge')}
            </Text>
          </View>
          <Text className="text-3xl font-extrabold tracking-tight" style={{ color: theme.text }}>
            {t('heroTitle')}
          </Text>
          <Text className="text-sm mt-1.5 leading-relaxed" style={{ color: theme.textSecondary }}>
            {t('heroSubtitle')}
          </Text>
        </View>

        <View
          className="border rounded-3xl p-4 mb-4"
          style={{ backgroundColor: theme.card, borderColor: theme.cardBorder }}
        >
          <View className="flex-row items-center mb-3">
            <View className="p-2 rounded-xl mr-3" style={{ backgroundColor: theme.primaryLight }}>
              <AudioLines size={18} color={theme.primary} />
            </View>
            <View className="flex-1">
              <Text className="font-bold text-base" style={{ color: theme.text }} numberOfLines={1}>
                {source ? source.name : t('noFileTitle')}
              </Text>
              <Text className="text-xs mt-0.5" style={{ color: theme.textSecondary }}>
                {source
                  ? t('fileReady', {
                      rate: Math.round(source.sampleRate / 1000),
                      duration: formatDuration(source.duration),
                    })
                  : t('noFileDesc')}
              </Text>
            </View>
          </View>
          <TouchableOpacity
            onPress={handlePick}
            disabled={busy}
            accessibilityRole="button"
            className="px-4 py-3 rounded-2xl flex-row items-center justify-center"
            style={{ backgroundColor: theme.controlSurface, opacity: busy ? 0.5 : 1, minHeight: 44 }}
          >
            <AudioLines size={16} color={theme.textSecondary} />
            <Text className="text-sm font-bold ml-2" style={{ color: theme.textSecondary }}>
              {source ? t('replaceFile') : t('chooseFile')}
            </Text>
          </TouchableOpacity>
        </View>

        {source && overFreeLimit() ? (
          <View
            className="border rounded-2xl p-3 mb-4"
            style={{ backgroundColor: theme.primaryLight, borderColor: theme.primaryBorder }}
          >
            <Text className="text-xs leading-relaxed" style={{ color: theme.primary }}>
              {t('freeLimitNotice', { seconds: FREE_SECONDS })}
            </Text>
          </View>
        ) : null}

        <TouchableOpacity
          onPress={handleClean}
          disabled={!source || busy}
          accessibilityRole="button"
          className="p-4 rounded-2xl flex-row items-center justify-center mb-4"
          style={{ backgroundColor: source && !busy ? theme.primary : theme.controlSurface, minHeight: 44 }}
        >
          {busy ? (
            <ActivityIndicator size="small" color={theme.onPrimary} />
          ) : (
            <Waves size={18} color={source ? theme.onPrimary : theme.textMuted} />
          )}
          <Text
            className="font-bold text-base ml-2 mr-2"
            style={{ color: source || busy ? theme.onPrimary : theme.textMuted }}
          >
            {stageLabel ?? t('clean')}
          </Text>
          {!busy ? <ForwardArrow size={18} color={source ? theme.onPrimary : theme.textMuted} /> : null}
        </TouchableOpacity>

        {report ? (
          <View
            className="border rounded-3xl p-4 mb-4"
            style={{ backgroundColor: theme.card, borderColor: theme.cardBorder }}
          >
            <View className="flex-row items-center mb-3">
              <Gauge size={16} color={theme.success} />
              <Text className="font-bold text-base ml-2" style={{ color: theme.text }}>
                {t('resultTitle')}
              </Text>
            </View>
            {[
              { label: t('loudnessBefore'), value: t('lufsUnit', { value: formatDb(report.loudnessBeforeLufs) }) },
              { label: t('loudnessAfter'), value: t('lufsUnit', { value: formatDb(report.loudnessAfterLufs) }) },
              { label: t('peakAfter'), value: t('dbUnit', { value: formatDb(report.peakAfterDb) }) },
              { label: t('gainApplied'), value: t('dbUnit', { value: formatDb(report.gain.gainDb) }) },
            ].map((row) => (
              <View key={row.label} className="flex-row justify-between py-1.5">
                <Text className="text-sm" style={{ color: theme.textSecondary }}>{row.label}</Text>
                <Text className="text-sm font-mono font-bold" style={{ color: theme.text }}>{row.value}</Text>
              </View>
            ))}
            {report.gain.peakLimited ? (
              <Text className="text-xs leading-relaxed mt-2" style={{ color: theme.warning }}>
                {t('peakLimitedNote')}
              </Text>
            ) : null}

            <View className="flex-row gap-3 mt-4">
              <TouchableOpacity
                onPress={handleSave}
                accessibilityRole="button"
                className="flex-1 px-4 py-3 rounded-2xl flex-row items-center justify-center"
                style={{ backgroundColor: theme.success, minHeight: 44 }}
              >
                <Save size={16} color={theme.onPrimary} />
                <Text className="text-sm font-bold ml-2" style={{ color: theme.onPrimary }}>
                  {t('save')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleShare}
                accessibilityRole="button"
                className="flex-1 px-4 py-3 rounded-2xl flex-row items-center justify-center"
                style={{ backgroundColor: theme.controlSurface, minHeight: 44 }}
              >
                <Share2 size={16} color={theme.textSecondary} />
                <Text className="text-sm font-bold ml-2" style={{ color: theme.textSecondary }}>
                  {t('share')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        <Text className="text-xs font-semibold tracking-widest mb-3" style={{ color: theme.textMuted }}>
          {t('archGuarantees')}
        </Text>
        {[
          { icon: <Gauge size={18} color={theme.primary} />, bg: theme.primaryLight, title: t('loudnessTitle'), desc: t('loudnessDesc') },
          { icon: <Waves size={18} color={theme.accent} />, bg: theme.accentLight, title: t('chainTitle'), desc: t('chainDesc') },
          { icon: <ShieldCheck size={18} color={theme.success} />, bg: theme.successLight, title: t('onDeviceTitle'), desc: t('onDeviceDesc') },
        ].map((item) => (
          <View
            key={item.title}
            className="border p-4 rounded-2xl flex-row items-start mb-3"
            style={{ backgroundColor: theme.card, borderColor: theme.cardBorder }}
          >
            <View className="p-2 rounded-xl mr-3" style={{ backgroundColor: item.bg }}>{item.icon}</View>
            <View className="flex-1">
              <Text className="font-bold text-sm mb-1" style={{ color: theme.text }}>{item.title}</Text>
              <Text className="text-xs leading-relaxed" style={{ color: theme.textSecondary }}>{item.desc}</Text>
            </View>
          </View>
        ))}
        {offerPrivacyOptions ? (
          <TouchableOpacity
            onPress={() => {
              void showPrivacyOptionsForm();
            }}
            accessibilityRole="button"
            className="mt-2 py-3 items-center"
            style={{ minHeight: 44 }}
          >
            <Text className="text-xs font-semibold underline" style={{ color: theme.textSecondary }}>
              {t('adPrivacySettings')}
            </Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
      {/* Anchored below the scroll area rather than inside it: a banner that scrolls with the
          content can sit under a finger reaching for the button above it. */}
      <AdBanner />
    </SafeAreaView>
  );
}
