var express = require('express')
var router = express.Router()
var serviceAccount = require('../firebase.json')
const {Configuration, OpenAIApi} = require('openai')
const axios = require('axios')
const {MilvusClient, DataType, MetricType} = require('@zilliz/milvus2-sdk-node')
const config = require('../config.js')
const {uri, user, password, secure} = config
const milvusClient = new MilvusClient(uri, secure, user, password, secure)

// Uuid
const {v4: uuidv4} = require('uuid')

// Firebase Setup
const admin = require('firebase-admin')
let defaultApp = admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})
let defaultDatabase = admin.firestore(defaultApp)

// Openai Setup
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
})
const openai = new OpenAIApi(configuration)

// Cohere Setup
const cohere = require('cohere-ai')
cohere.init(process.env.COHERE_API_KEY)

/* GET home page. */
router.get('/', function (req, res) {
  res.render('index', {title: 'Express'})
})

router.post('/add', async function (req, res) {
  const {userid, text} = req.body
  const embedding = await fetchEmbedding(text)
  const uuid = uuidv4()

  // Add the text and embedding to Firebase
  const userCollection = defaultDatabase.collection(userid)
  const document = userCollection.doc(uuid)

  try {
    await document.set({
      text: text,
      embedding: embedding,
    })

    const data = {
      collection_name: 'Resume',
      fields_data: [
        {
          uuid: uuid,
          vector: embedding,
          userid: userid,
        },
      ],
    }

    const ret = await milvusClient.insert(data)

    res.status(200).json({message: 'success', ret})
  } catch (error) {
    // Rollback: delete the document in Firebase if it was added
    const docSnapshot = await document.get()
    if (docSnapshot.exists) {
      await document.delete()
    }

    res.status(500).json({
      message: 'An error occurred while processing the transaction.',
      error: error.message,
    })
  }
})

/* POST route to handle JSON input */
router.post('/query', async function (req, res) {
  const {userid, text} = req.body

  if (userid && text) {
    // Reload collection
    await milvusClient.loadCollection({
      collection_name: 'Resume',
    })

    // Process the data as needed
    const embedding = await fetchEmbedding(text)
    const searchParams = {
      anns_field: 'vector',
      topk: 3,
      metric_type: MetricType.L2,
      params: JSON.stringify({nprobe: 1024}),
    }
    const searchReq = {
      collection_name: 'Resume',
      vectors: [embedding],
      search_params: searchParams,
      vector_type: DataType.FloatVector,
      expr: `userid == "${userid}"`,
      output_fields: ['uuid'],
    }

    const searchResults = await milvusClient.search(searchReq)
    // Process the search results
    const messagePromises = searchResults.results.map(async (result) => {
      // Find the corresponding document in firebase
      const id = result.id
      const docRef = defaultDatabase.collection(userid).doc(id)
      const doc = await docRef.get()

      const data = doc.data()
      const text = data.text
      console.log(text)
      return text
    })

    // Wait for all promises to resolve
    const messageArray = await Promise.all(messagePromises)

    // Send the response
    res.status(200).json({message: 'success', data: messageArray})
  } else {
    res.status(400).json({
      message: 'Bad request. Please provide both userid and text fields.',
    })
  }
})

router.post('/generate', async function (req, res) {
  const {description, text} = req.body

  if (text && description) {
    try {
      const prompt =
        'Generate a cover letter explaining why I would be a good fit for the company for the following job description: ' +
        description +
        ' Use the following information in the cover letter: ' +
        text +
        ' Do not make up any information.'
      const response = await cohere.generate({
        model: 'command-xlarge-nightly',
        prompt: prompt,
        maxTokens: 5000,
        temperature: 1.5,
        k: 5,
        stop_sequences: [],
        return_likelihoods: 'NONE',
      })

      res.status(200).json({message: 'success', data: response})
    } catch (error) {
      res.status(500).json({
        message: 'An error occurred while processing your request.',
        error: error.message,
      })
    }
  } else {
    res.status(400).json({
      message:
        'Bad request. Please provide a JSON string in the "jsonPrompt" field.',
    })
  }
})

module.exports = router

async function fetchEmbedding(text) {
  try {
    const response = await openai.createEmbedding({
      model: 'text-embedding-ada-002',
      input: text,
    })

    return response.data.data[0].embedding
  } catch (error) {
    console.error('Error fetching embedding:', error)
    throw error
  }
}
