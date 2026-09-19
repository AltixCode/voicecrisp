import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Linking,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Waves,
  BadgeCheck,
  Layers,
  ShoppingBag,
  Tag,
  ShieldCheck,
  X,
} from "lucide-react-native";
import { usePaywall } from "../src/hooks/usePaywall";
import { PRIVACY_POLICY_URL, TERMS_OF_USE_URL } from "../src/config/legal";
import { t } from "../src/i18n";
import { useTheme } from '../src/theme/useTheme';
import { useTabletColumn } from '../src/theme/useTabletColumn';

export default function PaywallScreen() {
  const theme = useTheme();
  const tabletColumn = useTabletColumn(640);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { ctaLabel, loading, errorMsg, handlePurchase, handleRestore } =
    usePaywall(() => router.back());

  const pills = [
    { icon: <Layers size={14} color={theme.accent} />, label: t("feat1Title") },
    { icon: <ShoppingBag size={14} color={theme.purple} />, label: t("feat2Title") },
    { icon: <Tag size={14} color={theme.warning} />, label: t("feat3Title") },
    { icon: <ShieldCheck size={14} color={theme.success} />, label: t("feat4Title") },
  ];

  return (
    <View className="flex-1 px-6 py-4" style={{ backgroundColor: theme.background }}>
      <TouchableOpacity
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel={t("cancel")}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        className="self-end rounded-full p-2"
        style={{ backgroundColor: theme.card }}
      >
        <X size={18} color={theme.textMuted} />
      </TouchableOpacity>

      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ ...tabletColumn }}>
          <Text className="mb-4 text-center text-2xl font-extrabold" style={{ color: theme.text }}>
            {t("paywallTitle")}
          </Text>

          <View
            className="mb-5 items-center rounded-3xl border p-6"
            style={{ borderColor: theme.primaryBorder, backgroundColor: theme.primaryLight }}
          >
            <View className="mb-3 h-14 w-14 items-center justify-center rounded-full" style={{ backgroundColor: theme.card }}>
              <BadgeCheck size={26} color={theme.primary} />
            </View>
            <Text className="text-center text-base font-bold" style={{ color: theme.text }}>
              {t("featAdsTitle")}
            </Text>
            <Text className="mt-1.5 text-center text-xs leading-relaxed" style={{ color: theme.textSecondary }}>
              {t("featAdsDesc")}
            </Text>
          </View>

          <View className="mb-5 flex-row flex-wrap justify-center" style={{ gap: 8 }}>
            {pills.map((p) => (
              <View
                key={p.label}
                className="flex-row items-center rounded-full border px-3 py-2"
                style={{ borderColor: theme.cardBorder, backgroundColor: theme.card }}
              >
                {p.icon}
                <Text className="ml-1.5 text-xs font-semibold" style={{ color: theme.text }}>{p.label}</Text>
              </View>
            ))}
          </View>

          <View className="mb-4 flex-row items-start rounded-xl p-4" style={{ backgroundColor: theme.controlSurface }}>
            <Waves size={16} color={theme.textMuted} />
            <Text className="ml-2 flex-1 text-xs leading-relaxed" style={{ color: theme.textSecondary }}>
              {t("antiSubDesc")}
            </Text>
          </View>

          {errorMsg ? (
            <Text
              accessibilityRole="alert"
              className="mb-3 text-center text-xs" style={{ color: theme.danger }}
            >
              {errorMsg}
            </Text>
          ) : null}
        </ScrollView>

        <View
          className="pt-2"
          style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          <TouchableOpacity
            onPress={handlePurchase}
            disabled={loading}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={ctaLabel}
            accessibilityState={{ disabled: loading, busy: loading }}
            className={`min-h-[56px] flex-row items-center justify-center rounded-full p-4 ${
              loading ? "bg-blue-900" : "bg-blue-600 active:bg-blue-500"
            }`}
          >
            {loading ? (
              <ActivityIndicator color={theme.onPrimary} />
            ) : (
              <Text className="text-base font-extrabold" style={{ color: theme.onPrimary }}>
                {ctaLabel}
              </Text>
            )}
          </TouchableOpacity>

          <View className="mt-4 flex-row items-center justify-center gap-5">
            <TouchableOpacity
              onPress={handleRestore}
              disabled={loading}
              accessibilityRole="button"
              hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            >
              <Text className="text-xs underline" style={{ color: theme.textSecondary }}>
                {t("restorePurchases")}
              </Text>
            </TouchableOpacity>
            <Text className="text-xs" style={{ color: theme.textMuted }}>•</Text>
            <Text className="text-xs" style={{ color: theme.textMuted }}>{t("oneTimePayment")}</Text>
          </View>

          <View className="mt-3 flex-row items-center justify-center gap-5">
            <TouchableOpacity
              onPress={() => Linking.openURL(TERMS_OF_USE_URL)}
              accessibilityRole="link"
              hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            >
              <Text className="text-xs underline" style={{ color: theme.textMuted }}>
                {t("termsOfUse")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}
              accessibilityRole="link"
              hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            >
              <Text className="text-xs underline" style={{ color: theme.textMuted }}>
                {t("privacyPolicy")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </View>
  );
}
