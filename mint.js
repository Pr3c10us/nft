const ethers = require('ethers');
require('dotenv').config();

const contractABI = [
    {
        "inputs": [
            {"internalType": "uint256", "name": "amount", "type": "uint256"},
            {
                "internalType": "uint256",
                "name": "mintId",
                "type": "uint256"
            }
        ],
        "name": "batchMint",
        "outputs": [
            {"internalType": "uint256", "name": "totalCostWithFee", "type": "uint256"}
        ],
        "stateMutability": "payable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "uint256",
                "name": "mintId",
                "type": "uint256"
            },
            {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
            }
        ],
        "name": "quoteBatchMint",
        "outputs": [
            {
                "internalType": "uint256",
                "name": "totalCostWithFee",
                "type": "uint256"
            },
            {
                "internalType": "uint256",
                "name": "feeAmount",
                "type": "uint256"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    }
];

const CONFIG = {
    chainId: 42161,
    name: 'Arbitrum One',
    currency: 'Ethereum',
    rpcUrl: 'https://arbitrum.llamarpc.com/',
    explorer: 'https://arbiscan.io/tx/',
    gasMultiplier: 1.5 // Add 20% to estimated gas price
};

// const CONFIG = {
//     chainId: 80084,
//     name: 'Berachain bArtio',
//     currency: 'BERA',
//     rpcUrl: 'https://bartio.rpc.berachain.com/',
//     explorer: 'https://bartio.beratrail.io/',
//     gasMultiplier: 1.5 // Add 20% to estimated gas price
// };

class WalletManager {
    constructor(provider) {
        this.provider = provider;
        this.wallets = [];
    }

    addWallet(privateKey) {
        const wallet = new ethers.Wallet(privateKey, this.provider);
        this.wallets.push(wallet);
        return wallet;
    }

    async loadWalletsFromEnv() {
        // Load multiple private keys from environment variables (PRIVATE_KEY_1, PRIVATE_KEY_2, etc.)
        let index = 1;
        while (true) {
            const privateKey = process.env[`PRIVATE_KEY_${index}`];
            if (!privateKey) break;
            this.addWallet(privateKey);
            index++;
        }
        console.log(`Loaded ${this.wallets.length} wallets`);
    }

    async checkAllBalances(requiredAmount) {
        const balances = await Promise.all(
            this.wallets.map(async (wallet) => {
                const balance = await this.provider.getBalance(wallet.address);
                return {wallet: wallet.address, balance};
            })
        );

        console.log('\nWallet Balances:');
        balances.forEach(({wallet, balance}) => {
            console.log(`${wallet}: ${ethers.formatEther(balance)} ETH`);
        });

        return balances;
    }
}

async function calculateGasParameters(provider) {
    const feeData = await provider.getFeeData();
    const block = await provider.getBlock('latest');
    const baseFee = block.baseFeePerGas;

    // Calculate maxFeePerGas with a buffer above current base fee
    const maxFeePerGas = baseFee * BigInt(Math.floor(CONFIG.gasMultiplier * 100)) / BigInt(100);

    // Calculate maxPriorityFeePerGas (tip)
    const maxPriorityFeePerGas = BigInt(1500000); // Set a reasonable tip

    return {
        maxFeePerGas,
        maxPriorityFeePerGas,
        baseFee
    };
}

async function batchMintNFTs(wallet, contractAddress, amount, mintId, affiliate) {
    try {
        const nftContract = new ethers.Contract(contractAddress, contractABI, wallet);
        // const gasParams = await calculateGasParameters(wallet.provider);
        //
        // console.log(`\nWallet ${wallet.address} - Gas parameters:`);
        // console.log(`Base fee: ${ethers.formatUnits(gasParams.baseFee, 'gwei')} gwei`);
        //
        // // Get quote first
        const [totalCost, feeAmount] = await nftContract.quoteBatchMint(mintId, amount);
        console.log(`Total cost: ${ethers.formatEther(totalCost)} BERA`);

        // Send transaction without waiting for gas estimation
        // This allows the transaction to be broadcast even if it might fail
        const mintTx = await nftContract.batchMint(
            amount,
            mintId,
            {
                value: totalCost,
                // maxFeePerGas: gasParams.maxFeePerGas,
                // maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
                // Set a reasonable fixed gas limit instead of estimating
                // gasLimit: 500000,
                type: 0
            }
        );

        console.log('Transaction hash:', mintTx.hash);
        console.log('View on block scanner:', CONFIG.explorer + mintTx.hash);

        // Wait for confirmation but don't throw on failure
        try {
            const receipt = await mintTx.wait();
            console.log(`Transaction confirmed for wallet ${wallet.address}! Block number:`, receipt.blockNumber);
            return receipt;
        } catch (waitError) {
            console.error(`Transaction failed for wallet ${wallet.address}:`, waitError.message);
            // Return the transaction hash even if it failed
            return { hash: mintTx.hash, failed: true };
        }

    } catch (error) {
        console.error(`Error in batch minting NFTs for wallet ${wallet.address}:`, error);
        throw error; // Propagate the error up
    }
}

async function processMintingForAllWallets(walletManager, contractAddress, amount, mintId, affiliate) {
    const mintingPromises = [];

    for (const wallet of walletManager.wallets) {
        // Execute 10 transactions concurrently for each wallet
        for (let i = 0; i < 10; i++) {
            mintingPromises.push(
                batchMintNFTs(wallet, contractAddress, amount, mintId, affiliate).catch((error) => {
                    console.error(`Failed minting for wallet ${wallet.address} (attempt ${i + 1}):`, error.message);
                    throw error;
                })
            );
        }
    }

    // Use allSettled to see both successful and failed results
    const results = await Promise.allSettled(mintingPromises);

    // Log all results, including failures
    results.forEach((result, index) => {
        const walletIndex = Math.floor(index / 10); // Determine which wallet executed the transaction
        const walletAddress = walletManager.wallets[walletIndex].address;
        const attemptNumber = (index % 10) + 1;

        if (result.status === 'fulfilled') {
            console.log(`Success for wallet ${walletAddress} (attempt ${attemptNumber}): ${result.value.hash}`);
        } else {
            console.log(`Failed for wallet ${walletAddress} (attempt ${attemptNumber}): ${result.reason}`);
        }
    });

    return results;
}

function timeout(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function pre_main() {
    const amount = 1;
    const mintId = 3;
    const affiliate = "0x0000000000000000000000000000000000000000";
    const contractAddress = process.env.CONTRACT_ADDRESS;

    try {
        const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
        const network = await provider.getNetwork();
        console.log(`Connected to network: ${network.name} (Chain ID: ${network.chainId})`);

        // Initialize wallet manager and load wallets
        const walletManager = new WalletManager(provider);
        await walletManager.loadWalletsFromEnv();

        if (walletManager.wallets.length === 0) {
            throw new Error('No wallets loaded. Please check your .env file');
        }

        // Check balances before minting
        await walletManager.checkAllBalances();

        const currentTimestamp = Date.now();

        let delay = 1736960399000 - currentTimestamp;
        if (delay > 0) {
            console.log(`Function will run in ${delay / 60000} minutes.`);
            console.log("Running the function at the specified timestamp!");
            await timeout(delay)
            // setTimeout(async () => {
            // Process minting for all wallets
            console.log('\nStarting minting process for all wallets...');
            const results = await processMintingForAllWallets(
                walletManager,
                contractAddress,
                amount,
                mintId,
                affiliate
            );

            console.log(`\nMinting completed for ${results.length} wallets`);
            // }, delay);
        } else {
            console.log("The target timestamp is in the past. Running the function immediately.");
            // Process minting for all wallets
            console.log('\nStarting minting process for all wallets...');
            const results = await processMintingForAllWallets(
                walletManager,
                contractAddress,
                amount,
                mintId,
                affiliate
            );

            console.log(`\nMinting completed for ${results.length} wallets`);
        }


    } catch (error) {
        console.error('Main function error:', error);
    }
}

// Environment variables needed in .env file:
// PRIVATE_KEY_1=your_first_wallet_private_key
// PRIVATE_KEY_2=your_second_wallet_private_key
// PRIVATE_KEY_3=your_third_wallet_private_key
// ... and so on
// CONTRACT_ADDRESS=nft_contract_address

const main = async () => {
    let count = 0;
    let cont = true;
    while (cont) {
        await pre_main().then(r => console.log({count}))
        // setTimeout(() => {
        // }, 10000)
        count++;
    }
}
main()