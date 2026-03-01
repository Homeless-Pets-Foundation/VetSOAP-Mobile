import { useQuery } from '@tanstack/react-query';
import { templatesApi } from '../api/templates';
import type { Template } from '../types';

const FIVE_MINUTES = 5 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

export function useTemplates() {
  const query = useQuery({
    queryKey: ['templates'],
    queryFn: () => templatesApi.list({ isActive: true }),
    staleTime: FIVE_MINUTES,
    gcTime: TWENTY_FOUR_HOURS,
    select: (response) => response.data,
  });

  const defaultTemplate = query.data?.find((t) => t.isDefault) ?? null;

  return {
    templates: query.data ?? [],
    defaultTemplate,
    isLoading: query.isLoading,
    error: query.error,
  };
}
