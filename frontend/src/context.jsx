import { createContext, useContext } from 'react';

export const SearchContext = createContext({ search: '', setSearch: () => {} });
export const PlatformContext = createContext();

export function useSearch() {
  return useContext(SearchContext);
}

export function usePlatform() {
  return useContext(PlatformContext);
}
