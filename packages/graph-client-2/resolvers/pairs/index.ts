import { chainShortName } from '@sushiswap/chain'
import {
  SUBGRAPH_HOST,
  SUSHISWAP_ENABLED_NETWORKS,
  SUSHISWAP_SUBGRAPH_NAME,
  TRIDENT_ENABLED_NETWORKS,
  TRIDENT_SUBGRAPH_NAME,
} from '@sushiswap/graph-config'
import { GraphQLResolveInfo } from 'graphql'

import {
  getBuiltGraphSDK,
  Query,
  QuerypairsByChainIdArgs,
  QuerypairsByChainIdsArgs,
  QueryResolvers,
  Resolvers,
} from '../../.graphclient'
import { page } from '../../lib/page'
import { SushiSwapTypes } from '.graphclient/sources/SushiSwap/types'
import { TridentTypes } from '.graphclient/sources/Trident/types'

const sdk = getBuiltGraphSDK()

const blacklist = ['0xd5c5e3ca5f162165a6eff096156ec70f77f3a491']

export const pairsWithFarms: QueryResolvers['pairsWithFarms'] = async (
  root,
  args,
  context,
  info
): Promise<Query['pairsWithFarms']> => {
  // console.log('farms', [await context.Farm.Query.farms({ root, args, context, info })])

  const [farms, pools, { oneDayBlocks }, { oneWeekBlocks }] = await Promise.all([
    context.FarmsV0.Query.farmsv0(root, args, context, info),
    _pairsByChainIds(root, args, context, info),
    sdk.OneDayBlocks({ chainIds: args.chainIds }),
    sdk.OneWeekBlocks({ chainIds: args.chainIds }),
  ])

  const poolIds = pools.map(({ id }) => id)

  const farmChainIds = Object.keys(farms)
    .map(Number)
    .filter((chainId) => args.chainIds.includes(chainId))

  //
  const farmPoolAddresses = Object.fromEntries(
    farmChainIds.map((chainId) => [
      chainId,
      Object.keys(farms?.[chainId]?.farms).filter((poolAddress) => !poolIds.includes(poolAddress)),
    ])
  )

  // Fetching farmPools just to be sure they weren't missed
  const [farmPools, pools1d, pools1w] = await Promise.all([
    Promise.all(
      farmChainIds
        .filter((chainId) => chainId in farmPoolAddresses)
        .map((chainId) =>
          _pairsByChainIds(
            root,
            {
              ...args,
              chainIds: [chainId],
              where: {
                id_in: farmPoolAddresses[chainId],
              },
            },
            context,
            info
          )
        )
    ).then((value) => value.flat()),
    Promise.all(
      args.chainIds.map((chainId, i) => {
        const ids = pools.filter((pool) => pool.chainId === chainId).map(({ id }) => id)
        return _pairsByChainIds(
          root,
          {
            ...args,
            chainIds: [chainId],
            first: ids.length > 1000 ? 1000 : ids.length,
            where: {
              id_in: ids,
            },
            block: { number: Number(oneDayBlocks?.[args.chainIds.indexOf(chainId)].number) },
          },
          context,
          info
        )
      })
    ).then((value) => value.flat()),
    Promise.all(
      args.chainIds.map((chainId, i) => {
        const ids = pools.filter((pool) => pool.chainId === chainId).map(({ id }) => id)
        return _pairsByChainIds(
          root,
          {
            ...args,
            chainIds: [chainId],
            first: ids.length > 1000 ? 1000 : ids.length,
            where: {
              id_in: ids,
            },
            block: { number: Number(oneWeekBlocks?.[args.chainIds.indexOf(chainId)].number) },
          },
          context,
          info
        )
      })
    ).then((value) => value.flat()),
  ])

  const transformed = Array.from(new Set([...pools, ...farmPools]))
    .filter((pool) => !blacklist.includes(pool.id))
    // this should be done way earlier...
    .filter((pool) =>
      args.farmsOnly
        ? farms?.[pool.chainId]?.farms?.[pool.id.toLowerCase()]?.incentives?.reduce(
            (previousValue, currentValue) => previousValue + Number(currentValue.apr),
            0
          ) > 0
        : true
    )
    .map((pool) => {
      const pool1d = Array.isArray(pools1d) ? pools1d?.find((oneDayPool) => oneDayPool.id === pool.id) : undefined
      const pool1w = Array.isArray(pools1w) ? pools1w?.find((oneWeekPool) => oneWeekPool.id === pool.id) : undefined
      const volume1w = pool1w ? Number(pool.volumeUSD) - Number(pool1w.volumeUSD) : 0
      const volume1d = pool1d ? Number(pool.volumeUSD) - Number(pool1d.volumeUSD) : 0
      const fees1w = pool1w ? Number(pool.feesUSD) - Number(pool1w.feesUSD) : 0
      const fees1d = pool1d ? Number(pool.feesUSD) - Number(pool1d.feesUSD) : 0
      const farm = farms?.[pool.chainId]?.farms?.[pool.id.toLowerCase()]
      const feeApr = pool?.apr
      const incentiveApr =
        farm?.incentives?.reduce((previousValue, currentValue) => previousValue + Number(currentValue.apr), 0) ?? 0
      const apr = Number(feeApr) + Number(incentiveApr)
      return {
        ...pool,
        id: `${chainShortName[pool.chainId]}:${pool.id}`,
        volume1d,
        volume1w,
        fees1w,
        fees1d,
        apr,
        feeApr,
        incentiveApr,
        farm: farm
          ? {
              id: farm.id,
              incentives: farm.incentives.map((incentive) => ({
                apr: String(incentive.apr),
                rewardPerDay: String(incentive.rewardPerDay),
                rewardToken: {
                  address: incentive.rewardToken.address,
                  symbol: incentive.rewardToken.symbol,
                  decimals: Number(incentive.rewardToken.decimals),
                },
                rewarderAddress: incentive.rewarder.address,
                rewarderType: incentive.rewarder.type,
              })),
              chefType: String(farm.chefType),
              poolType: String(farm.poolType),
            }
          : null,
      }
    })

  return page(
    transformed.sort((a, b) => {
      if (args.orderDirection === 'asc') {
        return a[args.orderBy || 'apr'] - b[args.orderBy || 'apr']
      } else if (args.orderDirection === 'desc') {
        return b[args.orderBy || 'apr'] - a[args.orderBy || 'apr']
      }
      return 0
    }),
    args.pagination
  )
}

const _pairsByChainIds = async (
  root = {},
  args: QuerypairsByChainIdsArgs,
  context: SushiSwapTypes.Context & TridentTypes.Context,
  info: GraphQLResolveInfo
): Promise<Query['pairsByChainIds']> => {
  return Promise.all<Query['pairsByChainIds'][]>([
    ...args.chainIds
      .filter((chainId): chainId is typeof SUSHISWAP_ENABLED_NETWORKS[number] =>
        SUSHISWAP_ENABLED_NETWORKS.includes(chainId)
      )
      .map((chainId) =>
        context.SushiSwap.Query.pairs({
          root,
          args: {
            ...args,
            where: { ...args.where, type_in: ['CONSTANT_PRODUCT_POOL'] },
          },
          context: {
            ...context,
            chainId,
            subgraphName: SUSHISWAP_SUBGRAPH_NAME[chainId],
            subgraphHost: SUBGRAPH_HOST[chainId],
          },
          info,
        }).then((pairs) => {
          if (!Array.isArray(pairs)) {
            console.error(`SushiSwap pairs query failed on ${chainId}`, pairs)
            return []
          }
          // console.debug(`SushiSwap pairs ${chainId}`, pairs)
          return pairs.map((pair) => ({ ...pair, chainId }))
        })
      ),
    ...args.chainIds
      .filter((chainId): chainId is typeof TRIDENT_ENABLED_NETWORKS[number] =>
        TRIDENT_ENABLED_NETWORKS.includes(chainId)
      )
      .map((chainId) =>
        context.Trident.Query.pairs({
          root,
          args,
          context: {
            ...context,
            chainId,
            subgraphName: TRIDENT_SUBGRAPH_NAME[chainId],
            subgraphHost: SUBGRAPH_HOST[chainId],
          },
          info,
        }).then((pairs) => {
          if (!Array.isArray(pairs)) {
            console.error(`Trident pairs query failed on ${chainId}`, pairs)
            return []
          }
          // console.debug(`Trident pairs ${chainId}`, pairs)
          return pairs.map((pair) => ({ ...pair, chainId }))
        })
      ),
  ]).then((promise) => promise.flatMap((pairs) => pairs))
}

export const pairsByChainIds: QueryResolvers['pairsByChainIds'] = async (
  root,
  args,
  context,
  info
): Promise<Query['pairsByChainIds']> => {
  return _pairsByChainIds(root, args, context, info)
}

export const _pairsByChainId = async (
  root = {},
  args: QuerypairsByChainIdArgs,
  context: SushiSwapTypes.Context & TridentTypes.Context,
  info: GraphQLResolveInfo
): Promise<Query['pairsByChainId']> => {
  return _pairsByChainIds(root, { ...args, chainIds: [args.chainId] }, context, info)
}

export const pairsByChainId: QueryResolvers['pairsByChainId'] = async (
  root,
  args,
  context,
  info
): Promise<Query['pairsByChainId']> => {
  return _pairsByChainId(root, args, context, info)
}

// const _pairsByIds = async (
//   root = {},
//   args: QuerypairsByIdsArgs,
//   context: SushiSwapTypes.Context & TridentTypes.Context,
//   info: GraphQLResolveInfo
// ): Promise<Query['pairsByIds']> => {

// }

export const resolvers: Resolvers = {
  Pair: {
    chainId: (root, args, context, info) => Number(root.chainId || context.chainId || 1),
  },
  Query: {
    // pairsByIds,
    pairsByChainId,
    pairsByChainIds,
    pairsWithFarms,
  },
}
