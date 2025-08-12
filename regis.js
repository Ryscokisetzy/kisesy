import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import {
  ID_REGISTRY_ADDRESS,
  ViemLocalEip712Signer,
  idRegistryABI,
  NobleEd25519Signer,
  BUNDLER_ADDRESS,
  bundlerABI,
  KEY_GATEWAY_ADDRESS,
  keyGatewayABI,
  makeUserDataAdd,
  makeVerificationAddEthAddress,
  makeVerificationAddressClaim,
  hexStringToBytes,
  Protocol,
  FarcasterNetwork,
  UserDataType,
  getSSLHubRpcClient,
  getInsecureHubRpcClient,
} from '@farcaster/hub-nodejs';
import * as ed from '@noble/ed25519';
import { bytesToHex, createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { optimism } from 'viem/chains';
import { faker } from '@faker-js/faker';
import { writeFileSync, mkdirSync, existsSync } from 'fs';

import 'dotenv/config'

const APP_PRIVATE_KEY = process.env.FUNDING_PRIVATE_KEY;
const FARCASTER_RECOVERY_PROXY = '0x00000000FcB080a4D6c39a9354dA9EB9bC104cd7';
const STORAGE_REGISTRY = '0x00000000fcCe7f938e7aE6D3c335bD6a1a7c593D';

const HUBS = [
  'crackle.farcaster.xyz:3383'
]

const USERNAME_PROOF_DOMAIN = {
  name: 'Farcaster name verification',
  version: '1',
  chainId: 1,
  verifyingContract: '0xe3be01d99baa8db9905b33a3ca391238234b79d1',
};

const USERNAME_PROOF_TYPE = {
  UserNameProof: [
    { name: 'name', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'owner', type: 'address' },
  ],
};

const storageRegistryABI = [
  { type: 'function', name: 'price', stateMutability: 'view', inputs: [{ name: 'units', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'rent', stateMutability: 'payable', inputs: [{ name: 'fid', type: 'uint256' }, { name: 'units', type: 'uint256' }], outputs: [] },
];

function createAccountsFolder() {
  if (!existsSync('accounts')) {
    mkdirSync('accounts', { recursive: true });
  }
}

function saveAccountToJSON(userAccount) {
  createAccountsFolder();
  const filename = `accounts/${userAccount.username}.json`;
  const accountData = {
    fid: userAccount.fid,
    username: userAccount.username,
    createdAt: userAccount.createdAt,
    custody: {
      address: userAccount.ethAddress,
      privateKey: userAccount.ethPrivateKey,
      recoveryPhrase: userAccount.recoveryPhrase
    },
    primarySigner: {
      address: userAccount.primarySignerAddress,
      privateKey: userAccount.farcasterAccountKey,
      publicKey: userAccount.farcasterPublicKey
    },
    additionalSigner: {
      address: userAccount.additionalSignerEthAddress,
      ed25519PublicKey: userAccount.additionalSignerPublicKey,
      ed25519PrivateKey: userAccount.additionalSignerPrivateKey,
      status: userAccount.signerStatus,
      txHash: userAccount.signerHash
    },
    verification: {
      status: userAccount.verificationStatus,
      blockHash: userAccount.verificationBlockHash
    },
    transactions: {
      registration: userAccount.transactionHash,
      signer: userAccount.signerHash
    },
    costs: {
      registration: userAccount.registrationCost,
      total: userAccount.totalCost
    }
  };
  
  writeFileSync(filename, JSON.stringify(accountData, null, 2));
}



const publicClient = createPublicClient({
  chain: optimism,
  transport: http('https://optimism.drpc.org'),
});

const walletClient = createWalletClient({
  chain: optimism,
  transport: http('https://optimism.drpc.org'),
});

if (!APP_PRIVATE_KEY) {
  throw new Error('FUNDING_PRIVATE_KEY is not set');
}

const app = privateKeyToAccount(`0x${APP_PRIVATE_KEY}`);
const appAccountKey = new ViemLocalEip712Signer(app);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkTransactionStatus(hash) {
  try {
    return await publicClient.getTransaction({ hash });
  } catch (error) {
    return null;
  }
}

async function waitForTransactionWithRetry(hash, maxRetries = 20, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await checkTransactionStatus(hash);
      
      const receipt = await publicClient.waitForTransactionReceipt({ 
        hash,
        timeout: 30000
      });
      
      return receipt;
      
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      
      await sleep(delayMs);
    }
  }
}

function getHub() {
  for (const hubUrl of HUBS) {
    try {
      try {
        const sslClient = getSSLHubRpcClient(hubUrl);
        return sslClient;
      } catch (sslError) {
        try {
          const insecureClient = getInsecureHubRpcClient(hubUrl);
          return insecureClient;
        } catch (insecureError) {
          continue;
        }
      }
    } catch (error) {
      continue;
    }
  }
  throw new Error('No Hub available');
}

function generateUserWallet() {
  const mnemonic = bip39.generateMnemonic(wordlist, 128);
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const hdkey = HDKey.fromMasterSeed(seed);
  
  const ethAccount = hdkey.derive("m/44'/60'/0'/0/0");
  const ethPrivateKeyHex = bytesToHex(ethAccount.privateKey);
  const ethPrivateKeyWithPrefix = ethPrivateKeyHex.startsWith('0x') ? ethPrivateKeyHex : `0x${ethPrivateKeyHex}`;
  const ethAddress = privateKeyToAccount(ethPrivateKeyWithPrefix).address;
  
  const farcasterAccount = hdkey.derive("m/44'/60'/0'/1/0");
  const farcasterPrivateKey = farcasterAccount.privateKey.slice(0, 32);
  
  return {
    mnemonic,
    ethAddress,
    ethPrivateKey: ethPrivateKeyWithPrefix,
    farcasterPrivateKey,
    account: privateKeyToAccount(ethPrivateKeyWithPrefix)
  };
}

async function checkExistingFID(address) {
  try {
    const fid = await publicClient.readContract({
      address: ID_REGISTRY_ADDRESS,
      abi: idRegistryABI,
      functionName: 'idOf',
      args: [address],
    });

    
    if (fid > 0n) {
      return { hasFid: true, fid: fid.toString() };
    } else {
      return { hasFid: false, fid: '0' };
    }
  } catch (error) {
    return { hasFid: false, fid: '0' };
  }
}

async function checkBalance(address) {
  const balance = await publicClient.getBalance({ address });
  return balance;
}

async function getRegistrationPrice() {
  const bundlerPrice = await publicClient.readContract({
    address: BUNDLER_ADDRESS,
    abi: bundlerABI,
    functionName: 'price',
    args: [0n],
  });
  
  return bundlerPrice;
}

async function getStoragePrice(units = 1n) {
  const storagePrice = await publicClient.readContract({
    address: STORAGE_REGISTRY,
    abi: storageRegistryABI,
    functionName: 'price',
    args: [units],
  });
  
  return storagePrice;
}

async function fundUserWallet(userAddress, amountEth) {
  const appBalance = await checkBalance(app.address);
  const requiredAmount = parseEther(amountEth.toString());
  
  if (appBalance < requiredAmount) {
    throw new Error('App wallet has insufficient balance for funding');
  }
  
  const hash = await walletClient.sendTransaction({
    account: app,
    to: userAddress,
    value: requiredAmount,
  });
  
  await waitForTransactionWithRetry(hash, 25, 3000);
  await sleep(3000);
}


async function registerUsername(userWallet, fid, fname) {
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    
    const value = {
      name: fname,
      timestamp: BigInt(timestamp),
      owner: userWallet.ethAddress,
    };
    
    const signature = await userWallet.account.signTypedData({
      domain: USERNAME_PROOF_DOMAIN,
      types: USERNAME_PROOF_TYPE,
      primaryType: 'UserNameProof',
      message: value,
    });
    
    const response = await fetch("https://fnames.farcaster.xyz/transfers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: fname,
        from: 0,
        to: parseInt(fid),
        fid: parseInt(fid),
        owner: userWallet.ethAddress,
        timestamp,
        signature,
      }),
    });
    
    if (!response.ok) {
      return { success: false, error: await response.text() };
    }
    
    return { success: true, username: fname };
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function submitToHub(message, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let hubClient;
    
    try {
      hubClient = getHub();
      const result = await hubClient.submitMessage(message);
      if (result.isOk()) {
        return { success: true };
      } else {
        if (attempt === maxRetries) {
          return { success: false, error: result.error };
        }
      }
    } catch (error) {
      if (attempt === maxRetries) {
        return { success: false, error: error.message };
      }
    } finally {
      if (hubClient) {
        hubClient.close();
      }
    }
    
    if (attempt < maxRetries) {
      await sleep(5000);
    }
  }
}

async function setUserData(fid, farcasterPrivateKey, type, value) {
  try {
    const fidNum = Number(fid);
    const signer = new NobleEd25519Signer(farcasterPrivateKey);
    
    const dataOptions = {
      fid: fidNum,
      network: FarcasterNetwork.MAINNET,
    };
    
    const result = await makeUserDataAdd(
      { type, value },
      dataOptions,
      signer
    );
    
    if (!result.isOk()) {
      return { success: false, error: result.error };
    }
    
    const submitResult = await submitToHub(result.value);
    return submitResult;
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function verifyEthAddress(fid, ethAddress, ethPrivateKey, farcasterPrivateKey) {
  try {
    const ethAccount = privateKeyToAccount(ethPrivateKey);
    const eip712Signer = new ViemLocalEip712Signer(ethAccount);
    const ed25519Signer = new NobleEd25519Signer(farcasterPrivateKey);
    
    const latestBlock = await publicClient.getBlock();
    const blockHash = latestBlock.hash;
    
    const addressBytesResult = await eip712Signer.getSignerKey();
    if (addressBytesResult.isErr()) {
      throw new Error(`Failed to get signer key: ${addressBytesResult.error}`);
    }
    
    const dataOptions = {
      fid: Number(fid),
      network: FarcasterNetwork.MAINNET,
    };
    
    const addressBytes = addressBytesResult.value;
    
    const blockHashBytesResult = hexStringToBytes(blockHash);
    if (blockHashBytesResult.isErr()) {
      throw new Error(`Failed to convert block hash: ${blockHashBytesResult.error}`);
    }
    const blockHashBytes = blockHashBytesResult.value;

    const claim = await makeVerificationAddressClaim(
      parseInt(fid),
      addressBytes,
      FarcasterNetwork.MAINNET,
      blockHashBytes,
      Protocol.ETHEREUM,
    );
    
    if (claim.isErr()) {
      throw new Error(`Failed to create verification claim: ${claim.error}`);
    }
    
    const ethSignResult = await eip712Signer.signVerificationEthAddressClaim(claim.value);
    if (ethSignResult.isErr()) {
      throw new Error(`Failed to sign ETH address claim: ${ethSignResult.error}`);
    }
    
    const verificationBody = {
      address: addressBytes,            
      claimSignature: ethSignResult.value, 
      blockHash: blockHashBytes,         
      verificationType: 0,        
      chainId: 0,                         
      protocol: Protocol.ETHEREUM,  
    };
    
    const verificationMessage = await makeVerificationAddEthAddress(
      verificationBody,
      dataOptions,
      ed25519Signer
    );
    
    if (verificationMessage.isErr()) {
      throw new Error(`Failed to create verification message: ${verificationMessage.error}`);
    }
    
    const submitResult = await submitToHub(verificationMessage.value);
    
    if (submitResult.success) {
      return { success: true, blockHash };
    } else {
      return { success: false, error: submitResult.error };
    }
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function generateKeyPair() {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKeyBytes = await ed.getPublicKeyAsync(privateKey);
  const publicKey = `0x${Buffer.from(publicKeyBytes).toString("hex")}`;
  const privateKeyHex = `0x${Buffer.from(privateKey).toString('hex')}`;
  const ethAccount = privateKeyToAccount(privateKeyHex);
  const ethAddress = ethAccount.address;
  
  return { privateKey, publicKey, ethAddress, privateKeyHex };
}

async function addSigner(userWallet, fid) {
  try {
    const { privateKey, publicKey, ethAddress, privateKeyHex } = await generateKeyPair();
    
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const userAccountKey = new ViemLocalEip712Signer(userWallet.account);
    const publicKeyBytes = new Uint8Array(Buffer.from(publicKey.slice(2), 'hex'));
    const signedKeyRequestMetadata = await userAccountKey.getSignedKeyRequestMetadata({
      requestFid: BigInt(fid),
      key: publicKeyBytes,
      deadline,
    });
    
    if (!signedKeyRequestMetadata.isOk()) {
      throw new Error('Failed to create signed key request metadata');
    }
    const metadata = bytesToHex(signedKeyRequestMetadata.value);
    const { request } = await publicClient.simulateContract({
      account: userWallet.account,
      address: KEY_GATEWAY_ADDRESS,
      abi: keyGatewayABI,
      functionName: 'add',
      args: [1, publicKey, 1, metadata],
    });
    
    const txHash = await walletClient.writeContract(request);
    await waitForTransactionWithRetry(txHash, 20, 3000);
    await sleep(5000);
    
    return {
      success: true,
      signerEthAddress: ethAddress,
      signerPublicKey: publicKey,
      signerPrivateKey: privateKeyHex,
      txHash
    };
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function registerUserAccount() {
  try {
    console.log('🚀 Starting Farcaster registration...');
    
    const appFidInfo = await checkExistingFID(app.address);
    if (!appFidInfo.hasFid) {
      console.log('❌ App has no FID! Register app first.');
      return;
    }
    const APP_FID = BigInt(appFidInfo.fid);
    
    console.log('📝 Generating new wallet...');
    const userWallet = generateUserWallet();
    
    const userFidInfo = await checkExistingFID(userWallet.ethAddress);
    
    if (userFidInfo.hasFid) {
      console.log('✅ User already has account!');
      console.log(`FID: ${userFidInfo.fid}`);
      console.log(`Address: ${userWallet.ethAddress}`);
      return { existing: true, fid: userFidInfo.fid, wallet: userWallet };
    }
    
    console.log('💰 Checking balance and funding if needed...');
    const initialBalance = await checkBalance(userWallet.ethAddress);
    const registrationPrice = await getRegistrationPrice();
    
    if (initialBalance < registrationPrice) {
      const needed = Number(registrationPrice - initialBalance) / 1e18;
      const gasEstimate = 0.00002;
      const fundAmount = needed + gasEstimate;
      
      console.log(`   Funding ${fundAmount.toFixed(8)} ETH...`);
      await fundUserWallet(userWallet.ethAddress, fundAmount);
      
      const newBalance = await checkBalance(userWallet.ethAddress);
      if (newBalance < registrationPrice) {
        console.log('❌ Still insufficient after funding!');
        return;
      }
    }
    
    console.log('🔑 Preparing signatures and keys...');
    const userAccountKey = new ViemLocalEip712Signer(userWallet.account);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    
    let nonce = await publicClient.readContract({
      address: KEY_GATEWAY_ADDRESS,
      abi: keyGatewayABI,
      functionName: 'nonces',
      args: [userWallet.ethAddress],
    });
    
    const registerSignatureResult = await userAccountKey.signRegister({
      to: userWallet.ethAddress,
      recovery: FARCASTER_RECOVERY_PROXY,
      nonce,
      deadline,
    });
    
    if (!registerSignatureResult.isOk()) {
      throw new Error('Failed to create register signature');
    }
    const registerSignature = registerSignatureResult.value;
    
    const accountKey = new NobleEd25519Signer(userWallet.farcasterPrivateKey);
    const accountKeyResult = await accountKey.getSignerKey();
    
    if (!accountKeyResult.isOk()) {
      throw new Error('Failed to get account key');
    }
    const accountPubKey = accountKeyResult.value;
    
    const signedKeyRequestMetadata = await appAccountKey.getSignedKeyRequestMetadata({
      requestFid: APP_FID,
      key: accountPubKey,
      deadline,
    });
    
    if (!signedKeyRequestMetadata.isOk()) {
      throw new Error('Failed to create signed key request');
    }
    const metadata = bytesToHex(signedKeyRequestMetadata.value);
    
    nonce = await publicClient.readContract({
      address: KEY_GATEWAY_ADDRESS,
      abi: keyGatewayABI,
      functionName: 'nonces',
      args: [userWallet.ethAddress],
    });
    
    const addSignatureResult = await userAccountKey.signAdd({
      owner: userWallet.ethAddress,
      keyType: 1,
      key: accountPubKey,
      metadataType: 1,
      metadata,
      nonce,
      deadline,
    });
    
    if (!addSignatureResult.isOk()) {
      throw new Error('Failed to create add signature');
    }
    const addSignature = addSignatureResult.value;
    
    console.log('⛓️ Submitting registration to blockchain...');
    const { request } = await publicClient.simulateContract({
      account: userWallet.account,
      address: BUNDLER_ADDRESS,
      abi: bundlerABI,
      functionName: 'register',
      args: [
        {
          to: userWallet.ethAddress,
          recovery: FARCASTER_RECOVERY_PROXY,
          sig: bytesToHex(registerSignature),
          deadline,
        },
        [
          {
            keyType: 1,
            key: bytesToHex(accountPubKey),
            metadataType: 1,
            metadata: metadata,
            sig: bytesToHex(addSignature),
            deadline,
          },
        ],
        0n,
      ],
      value: registrationPrice,
    });
    
    const hash = await walletClient.writeContract(request);
    
    console.log('⏳ Waiting for transaction confirmation...');
    const receipt = await waitForTransactionWithRetry(hash, 30, 3000);
    await sleep(5000);
    
    const newFID = await publicClient.readContract({
      address: ID_REGISTRY_ADDRESS,
      abi: idRegistryABI,
      functionName: 'idOf',
      args: [userWallet.ethAddress],
    });
    
    console.log('🔑 Adding additional signer...');
    let signerInfo = { success: false };
    
    try {
      signerInfo = await addSigner(userWallet, newFID.toString());
    } catch (error) {
      // Silent fail - additional signer is optional
    }
    
    console.log('📝 Setting up username and profile...');
    const desiredUsername = `user${newFID}`;
    let usernameInfo = { success: false };
    
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await registerUsername(userWallet, newFID.toString(), desiredUsername);
        
        if (result.success) {
          usernameInfo = result;
          break;
        } else {
          if (attempt < 3) {
            await sleep(5000);
          }
        }
      }
    } catch (error) {
      // Silent fail
    }
    
    
    await setUserData(newFID.toString(), userWallet.farcasterPrivateKey, UserDataType.USERNAME, desiredUsername);
    await setUserData(newFID.toString(), userWallet.farcasterPrivateKey, UserDataType.DISPLAY, faker.internet.username());
    await setUserData(newFID.toString(), userWallet.farcasterPrivateKey, UserDataType.BIO, `Hello! I'm ${desiredUsername} on Farcaster 🚀`);
    
    console.log('🔐 Verifying ETH address...');

    let verificationInfo = { success: false };
    try {
      verificationInfo = await verifyEthAddress(
        newFID.toString(), 
        userWallet.ethAddress, 
        userWallet.ethPrivateKey, 
        userWallet.farcasterPrivateKey
      );
    } catch (error) {
      // Silent fail
    }
    
    const finalBalance = await checkBalance(userWallet.ethAddress);
    const registrationCostEth = Number(registrationPrice) / 1e18;
    
    const primarySignerPrivateKeyHex = `0x${bytesToHex(userWallet.farcasterPrivateKey).slice(2)}`;
    const primarySignerAccount = privateKeyToAccount(primarySignerPrivateKeyHex);
    const primarySignerAddress = primarySignerAccount.address;
    
    const userAccount = {
      fid: newFID.toString(),
      recoveryPhrase: userWallet.mnemonic,
      ethAddress: userWallet.ethAddress,
      ethPrivateKey: userWallet.ethPrivateKey,
      primarySignerAddress: primarySignerAddress,
      farcasterAccountKey: bytesToHex(userWallet.farcasterPrivateKey),
      farcasterPublicKey: bytesToHex(accountPubKey),
      additionalSignerEthAddress: signerInfo?.success ? signerInfo.signerEthAddress : 'none',
      additionalSignerPublicKey: signerInfo?.success ? signerInfo.signerPublicKey : 'none',
      additionalSignerPrivateKey: signerInfo?.success ? signerInfo.signerPrivateKey : 'none',
      registrationCost: registrationCostEth.toFixed(8),
      totalCost: registrationCostEth.toFixed(8),
      username: usernameInfo?.success ? usernameInfo.username : desiredUsername,
      usernameStatus: usernameInfo?.success ? 'registered' : 'failed',
      signerStatus: signerInfo?.success ? 'added' : 'pending',
      verificationStatus: verificationInfo?.success ? 'verified' : 'pending',
      verificationBlockHash: verificationInfo?.blockHash || 'none',
      transactionHash: hash,
      signerHash: signerInfo?.txHash || 'none',
      createdAt: new Date().toISOString()
    };
    
    console.log('🎉 Registration complete!');
    console.log(`   FID: ${userAccount.fid}`);
    console.log(`   Username: @${userAccount.username}`);
    console.log(`   Address: ${userAccount.ethAddress}`);
    console.log(`   Profile: https://warpcast.com/${userAccount.username}`);
    
    const accountLine = `${userAccount.ethAddress},${userAccount.ethPrivateKey},${userAccount.recoveryPhrase},${userAccount.fid}\n`;
    writeFileSync('accounts.txt', accountLine, { flag: 'a' });
    
    saveAccountToJSON(userAccount);
    
    return userAccount;
    
  } catch (error) {
    console.error('❌ Registration failed:', error.message);
    throw error;
  }
}

async function main() {
  try {
    const result = await registerUserAccount();
  } catch (error) {
    console.error('❌ Registration failed:', error.message);
    process.exit(1);
  }
}

main().catch(console.error);