import tsyringe = require("tsyringe");

import { LocationCallbacks } from "@spt-aki/callbacks/LocationCallbacks";
import { DialogueController } from "@spt-aki/controllers/DialogueController";
import { GameController } from "@spt-aki/controllers/GameController";
import { LocationController } from "@spt-aki/controllers/LocationController";
import { AkiHttpListener } from "@spt-aki/servers/http/AkiHttpListener";
import { SaveServer } from "@spt-aki/servers/SaveServer";
import { HttpResponseUtil } from "@spt-aki/utils/HttpResponseUtil";


import { Friend, IGetFriendListDataResponse } from "@spt-aki/models/eft/dialog/IGetFriendListDataResponse";
import { IGameConfigResponse } from "@spt-aki/models/eft/game/IGameConfigResponse";
import MemberCategory = require("@spt-aki/models/enums/MemberCategory");

import type { IPreAkiLoadMod } from "@spt-aki/models/external/IPreAkiLoadMod";
import type { ILogger } from "@spt-aki/models/spt/utils/ILogger";
import { HttpBufferHandler } from "@spt-aki/servers/http/HttpBufferHandler";
import type { DynamicRouterModService } from "@spt-aki/services/mod/dynamicRouter/DynamicRouterModService";
import type { StaticRouterModService } from "@spt-aki/services/mod/staticRouter/StaticRouterModService";

import { DatabaseServer } from "@spt-aki/servers/DatabaseServer";
import { IncomingMessage, ServerResponse } from "http";
import zlib from "zlib";

import { IGetLocationRequestData } from "@spt-aki/models/eft/location/IGetLocationRequestData";
import { CoopConfig } from "./CoopConfig";
import { CoopMatch, CoopMatchEndSessionMessages, CoopMatchStatus } from "./CoopMatch";
import { ExternalIPFinder } from "./ExternalIPFinder";
import { WebSocketHandler } from "./WebSocketHandler";

import { RouteAction } from "@spt-aki/di/Router";
import { BundleLoader } from "@spt-aki/loaders/BundleLoader";
import { ConfigTypes } from "@spt-aki/models/enums/ConfigTypes";
import { IPostDBLoadMod } from "@spt-aki/models/external/IPostDBLoadMod";
import { ConfigServer } from "@spt-aki/servers/ConfigServer";
import { JsonUtil } from "@spt-aki/utils/JsonUtil";
import { VFS } from "@spt-aki/utils/VFS";
import { BundleLoaderFixed } from "./BundleLoaderFixed";
import { SITConfig } from "./SITConfig";
import moment = require("moment");
import AzureWAH = require("./AzureWebAppHelper");

// -------------------------------------------------------------------------
// Custom Traders (needs to be refactored into SITCustomTraders.ts)
import { BearTrader } from "./Traders/BearTrader";
import { CoopGroupTrader } from "./Traders/CoopGroupTrader";
import { UsecTrader } from "./Traders/UsecTrader";
// -------------------------------------------------------------------------


@tsyringe.injectable()
export class StayInTarkovMod implements IPreAkiLoadMod, IPostDBLoadMod
{
    public static Instance: StayInTarkovMod;
    private static container: tsyringe.DependencyContainer;

    saveServer: SaveServer;
    locationController: LocationController;
    httpBufferHandler: HttpBufferHandler;
    protected httpResponse: HttpResponseUtil;
    databaseServer: DatabaseServer;
    public webSocketHandler: WebSocketHandler;
    public externalIPFinder: ExternalIPFinder;
    public coopConfig: CoopConfig;
    public sitConfig: SITConfig;
    locationData: object = {};
    locationData2: object = {};
    configServer: ConfigServer;
    httpConfig: any;
    bundleLoader: BundleLoader;
    resolvedExternalIP: string;

    public traders: any[] = [];

    public getCoopMatch(serverId: string) : CoopMatch {

        if(serverId === undefined) {
            console.error("getCoopMatch -- no serverId provided");
            return undefined;
        }

        if(CoopMatch.CoopMatches[serverId] === undefined) {
            console.error(`getCoopMatch -- no server of ${serverId} exists`);
            return undefined;
        }

        return CoopMatch.CoopMatches[serverId];
    } 

    private InitializeVariables(container: tsyringe.DependencyContainer): void { 
        // ----------------------------------------------------------------
        // Initialize & resolve variables
        StayInTarkovMod.container = container;
        StayInTarkovMod.Instance = this;
        const logger = container.resolve<ILogger>("WinstonLogger");
        const dynamicRouterModService = container.resolve<DynamicRouterModService>("DynamicRouterModService");
        const staticRouterModService = container.resolve<StaticRouterModService>("StaticRouterModService");
        this.saveServer = container.resolve<SaveServer>("SaveServer");
        CoopMatch.saveServer = this.saveServer;
        this.locationController = container.resolve<LocationController>("LocationController");
        this.httpBufferHandler  = container.resolve<HttpBufferHandler>("HttpBufferHandler");
        this.databaseServer = container.resolve<DatabaseServer>("DatabaseServer");
        this.httpResponse = container.resolve<HttpResponseUtil>("HttpResponseUtil");
        this.configServer = container.resolve<ConfigServer>("ConfigServer");
        // get http.json config
        this.httpConfig = this.configServer.getConfig(ConfigTypes.HTTP);
        this.coopConfig = new CoopConfig();
        this.sitConfig = new SITConfig();
        this.webSocketHandler = new WebSocketHandler(this.coopConfig.webSocketPort, logger);
        this.bundleLoader = container.resolve<BundleLoader>("BundleLoader");

        this.traders.push(new CoopGroupTrader(), new UsecTrader(), new BearTrader());
    }

    public preAkiLoad(container: tsyringe.DependencyContainer): void {


        const logger = container.resolve<ILogger>("WinstonLogger");
        const dynamicRouterModService = container.resolve<DynamicRouterModService>("DynamicRouterModService");
        const staticRouterModService = container.resolve<StaticRouterModService>("StaticRouterModService");
        this.InitializeVariables(container);
        this.sitConfig.routeHandler(container);

        // Initialize Custom Traders
        for(const t of this.traders) {
            t.preAkiLoad(container);
        }
     
        this.externalIPFinder = new ExternalIPFinder(this.coopConfig, this.httpConfig);
        
        // ----------------------- Bundle Loader Fixes ------------------------------------------------
        const bundleLoaderFixed = new BundleLoaderFixed(container.resolve<VFS>("VFS"), container.resolve<JsonUtil>("JsonUtil"), this.externalIPFinder);
        bundleLoaderFixed.resolveAndOverride(container);

        // ----------------------- TODO: Azure WebApp Helper (trying to fix this ASAP) ------------------------------------------------
        new AzureWAH.AzureWebAppHelper(this.configServer);

        dynamicRouterModService.registerDynamicRouter(
            "sit-coop-loot",
            [
                new RouteAction(
                    "/coop/server/spawnPoint",
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    (url: string, info: any, sessionID: string, output: string): any =>
                    {

                        const splitUrl = url.split("/");
                        const matchId = splitUrl.pop();

                        var spawnPoint = { x: 0, y: 0, z: 0 };
                        if(matchId !== undefined) {
                            // console.log("matchId:" + matchId);
                            const coopMatch = this.getCoopMatch(matchId);
                            if(coopMatch !== undefined)
                                spawnPoint = coopMatch.SpawnPoint;
                        }


                        output = JSON.stringify(spawnPoint);
                        return output;
                    }
                ),
            ]
            ,"aki"
        )

        staticRouterModService.registerStaticRouter(
            "MyStaticModRouter",
            [
                // {
                //     url: "/SIT/Config",
                //     action: (url, info: any, sessionId, output) => {
                //         console.log(SITConfig.Instance)
                //         output = JSON.stringify(this.sitConfig);
                //         return output;
                //     }
                // },
                {
                    url: "/coop/server/create",
                    action: (url, info: any, sessionId, output) => {
                        logger.info(`Start a Coop Server ${sessionId}`);
                        // logger.info("Coop Data:_________");
                        // logger.info(info);
                        // logger.info("___________________");
                        let currentCoopMatch = CoopMatch.CoopMatches[info.serverId];
                        if(currentCoopMatch !== undefined && currentCoopMatch !== null) {
                            currentCoopMatch.endSession(CoopMatchEndSessionMessages.HOST_SHUTDOWN_MESSAGE);
                            delete CoopMatch.CoopMatches[info.serverId];
                            currentCoopMatch = undefined;
                        }

                        CoopMatch.CoopMatches[info.serverId] = new CoopMatch(info);
                        // this.CoopMatches[info.serverId].Settings = info.settings;
                        CoopMatch.CoopMatches[info.serverId].Location = info.settings.location;
                        CoopMatch.CoopMatches[info.serverId].Time = info.settings.timeVariant;
                        CoopMatch.CoopMatches[info.serverId].WeatherSettings = info.settings.timeAndWeatherSettings;
                        output = JSON.stringify({ serverId:  info.serverId });
                        return output;
                    }
                },
                {
                    url: "/coop/server/exist",
                    action: (url, info, sessionId, output) => {
                        
                        let coopMatch: CoopMatch = null;
                        for (let cm in CoopMatch.CoopMatches)
                        {
                            // logger.info(JSON.stringify(this.CoopMatches[cm]));

                            if (CoopMatch.CoopMatches[cm].Location != info.location)
                                continue;

                            if(CoopMatch.CoopMatches[cm].Time != info.timeVariant)
                                continue;

                            if (CoopMatch.CoopMatches[cm].Status == CoopMatchStatus.Complete)
                                continue;

                            if (CoopMatch.CoopMatches[cm].LastUpdateDateTime < new Date(Date.now() - (1000 * 5)))
                                continue;

                            coopMatch = CoopMatch.CoopMatches[cm];
                        }
                        logger.info(coopMatch !== null ? "match exists" : "match doesn't exist!");

                        output = JSON.stringify(coopMatch !== null ? { ServerId: coopMatch.ServerId } : null);
                        return output;
                    }
                },
                {
                    url: "/coop/server/read/players",
                    action: (url, info, sessionId, output) => {
                        
                        // ---------------------------------------------------------------------------------------------------
                        // This call requires the client to pass what players/bots it knows about to filter the response back!

                        let coopMatch = this.getCoopMatch(info.serverId);
                        if(coopMatch == null || coopMatch == undefined)
                        {
                            output = JSON.stringify([{ notFound: true }]);
                            return output; 
                        }

                        //
                        let charactersToSend:any[] = [];
                        let playersToFilterOut:string[] = info.pL;
                        for(var c of coopMatch.Characters) {
                            if(!playersToFilterOut.includes(c.accountId)) {
                                charactersToSend.push(c);
                            }
                        }

                        output = JSON.stringify(charactersToSend);
                        // console.log(output);
                        return output;
                    }
                },
                {
                    url: "/coop/server/update",
                    action: (url, info, sessionId, output) => {
                        if(info === undefined || info.serverId === undefined) {

                            if(JSON.stringify(info).charAt(0) === '[') {
                                for(var item of info) {
                                    let coopMatch = this.getCoopMatch(item.serverId);
                                    if(coopMatch === undefined)
                                        break;

                                    coopMatch.ProcessData(item, logger);
                                }
                                output = JSON.stringify({});
                                return output; 
                            }

                            console.error("/coop/server/update -- no info or serverId provided");
                            output = JSON.stringify({ response: "ERROR" });
                            return JSON.stringify({ response: "ERROR" });
                        }

                        // let timeCheck = Date.now();

                        // console.log(info);
                        let coopMatch = this.getCoopMatch(info.serverId);
                        if(coopMatch == null || coopMatch == undefined)
                        {
                            console.error("/coop/server/update -- no coopMatch found to update");

                            output = JSON.stringify({});
                            return output; 
                        }

                        coopMatch.ProcessData(info, logger);
                        

                        // 
                        // console.log(Date.now() - timeCheck);


                        output = JSON.stringify({});
                        return output;
                    }
                },
                {
                    url: "/coop/server/delete",
                    action: (url, info, sessionId, output) => {
                        // logger.info("Update a Coop Server");
                        console.log(info);
                        output = JSON.stringify({ response: "OK" });
                        return JSON.stringify({ response: "OK" });
                    }
                },
                {
                    url: "/coop/get-invites",
                    action: (url: string, info: any, sessionID: string, output: string): any => 
                    {
                        logger.info("Getting Coop Server Invites")
                        const obj = {
                            "players": [{}, {}],
                            "invite": [],
                            "group": []
                        };

                        output = JSON.stringify(obj);
                        return output;
                    }
                },
                {
                    url: "/coop/server-status",
                    action: (url, info, sessionId, output) => 
                    {
                        logger.info("Getting Coop Server Match Status")
                        return "";
                    }
                },
               
                
                
                
            ],
            "sit-coop"
            // "aki"
        );

        // Hook up to existing AKI static route
        staticRouterModService.registerStaticRouter(
            "MatchStaticRouter-SIT",
            [
                {
                    url: "/client/match/group/status",
                    action: (url: string, info: any, sessionID: string, output: string): any => 
                    {
                        logger.info("/client/match/group/status")
                        logger.info("Getting Coop Server Match Status")
                        const obj = {
                            "players": [],
                            "invite": [],
                            "group": []
                        };
                        output = JSON.stringify(obj);
                        return output;
                    }
                },
                // {
                //     url: "/client/match/group/current",
                //     action: (url: string, info: any, sessionID: string, output: string): any => 
                //     {
                //         logger.info("/client/match/group/current")
                //         logger.info("TODO: Look into Getting Group Current")

                //         const myAccount = this.saveServer.getProfile(sessionID);
                //         if(myAccount === undefined) { 
                //             console.log("own account cannot be found");
                //             return null;
                //         }
                //         let squadList: Friend[] = [];
                //         // console.log(allAccounts);
                //         // {
                //         //     let squadMember: Friend = {
                //         //         _id: myAccount.info.id,
                //         //         Info: {
                //         //             Level: myAccount.characters.pmc.Info.Level,
                //         //             Nickname: myAccount.info.username,
                //         //             Side: myAccount.characters.pmc.Info.Side,
                //         //             MemberCategory: MemberCategory.DEFAULT
                //         //         }
                //         //     };
                //         //     squadList.push(squadMember);
                //         // }


                //         const obj = {
                //             squad: squadList,
                //             raidSettings: {}
                //         };
                //         output = JSON.stringify({ data: obj, err: 0, errmsg: null });
                //         return output;
                //     }
                // },
                {
                    url: "/client/match/group/exit_from_menu",
                    action: (url: string, info: any, sessionID: string, output: string): any => 
                    {
                        logger.info("exit_from_menu")
                        output = JSON.stringify({});
                        return output;
                    }
                }
                ,{
                    url: "/client/match/group/exit_from_menu",
                    action: (url: string, info: any, sessionID: string, output: string): any => 
                    {
                        logger.info("exit_from_menu")
                        output = JSON.stringify({});
                        return output;
                    }
                },
                {
                    url: "/client/raid/person/killed",
                    action: (url: string, info: any, sessionID: string, output: string): any => 
                    {
                        logger.info("Person has been Killed!")
                        console.log(info);
                        output = JSON.stringify(info);
                        return output;
                    }
                },
                {
                    url: "/client/raid/createFriendlyAI",
                    action: (url: string, info: any, sessionID: string, output: string): any => 
                    {
                        // logger.info("Person has been Killed!")
                        console.log(info);
                        output = JSON.stringify(info);
                        return output;
                    }
                },
                {
                    url: "/client/match/raid/ready",
                    action: (url: string, info: any, sessionID: string, output: string): any => 
                    {
                        console.log(url);
                        console.log(info);
                        console.log(sessionID);
                        output = JSON.stringify({});
                        return output;
                    }
                },
                {
                    url: "/client/match/raid/not-ready",
                    action: (url: string, info: any, sessionID: string, output: string): any => 
                    {
                        console.log(url);
                        console.log(info);
                        console.log(sessionID);
                        output = JSON.stringify({});
                        return output;
                    }
                },
                {
                    url: "/client/match/group/invite/cancel-all",
                    action: (url: string, info: any, sessionID: string, output: string): any => 
                    {
                        console.log(url);
                        console.log(info);
                        console.log(sessionID);
                        output = JSON.stringify({});
                        return output;
                    }
                },
                {
                    url: "/client/match/available",
                    action: (url: string, info: any, sessionID: string, output: string): any => 
                    {
                        console.log(url);
                        console.log(info);
                        console.log(sessionID);
                        output = JSON.stringify(false);
                        return output;
                    }
                }
            ],
            "aki"
        );


        container.afterResolution("LocationCallbacks", (_t, result: LocationCallbacks) => {

            // result.getLocationData = (url: string, info: IEmptyRequestData, sessionID: string) => {


            // }

            result.getLocation = (url: string, info: IGetLocationRequestData, sessionID: string) => {


                // This is HACK to test out getting same loot on multiple clients
                if (this.locationData[info.locationId] === undefined) {
                    console.log(`No cached locationData found for ${info.locationId}. Creating it now!`);
                    this.generateNewLootForLocation(info.locationId, sessionID);
                    this.locationData[info.locationId].Loot = this.locationData[info.locationId].Data.Loot;
                }

                // // This is a HACK. For some reason (not figured out yet) the Loot field empties after it has been generated. So refilling it here.
                if (this.locationData[info.locationId].Data.Loot.length === 0) 
                {
                    this.locationData[info.locationId].Data.Loot = this.locationData[info.locationId].Loot;
                }

                return this.httpResponse.getBody(this.locationData[info.locationId].Data);

            }

            // result.getAirdropLoot = (url: string, info: IEmptyRequestData, sessionID: string) => {

            //     if(CoopMatch.AirdropLoot === undefined) {
            //         CoopMatch.AirdropLoot = this.locationController.getAirdropLoot();
            //     }

            //     return this.httpResponse.noBody(CoopMatch.AirdropLoot);
                
            // }

        }, {frequency: "Always"});

        container.afterResolution("LocationController", (_t, result: LocationController) => {

            result.get = (location: string) => {

                if (this.locationData2[location] === undefined) {

                    // const name = location.toLowerCase().replace(" ", "");
                    // this.locationData2[location] = result.generate(name);
                    this.locationData2[location] = result.get(location);
                }
                
                return this.locationData2[location];
            }


        }, {frequency: "Always"});

        /**
         * WIP/UNUSED FEATURE: GET FRIENDS LIST
         */
        container.afterResolution("DialogueController", (_t, result: DialogueController) => 
        {
            // We want to replace the original method logic with something different
            result.getFriendList = (sessionID: string) => 
            {
                return this.getFriendsList(sessionID);
            }
            // The modifier Always makes sure this replacement method is ALWAYS replaced
        }, {frequency: "Always"});

        /**
         * MUST HAVE: REPLACE HTTP REQUEST HANDLER
         */
        container.afterResolution("AkiHttpListener", (_t, result: AkiHttpListener) => 
        {
            result.handle = (sessionId: string, req: IncomingMessage, resp: ServerResponse) => 
            {
                return this.sitHttpHandler(sessionId, req, resp, result);
            }
        }, {frequency: "Always"});
        
        /**
         * MUST HAVE: REPLACE GAME CONFIG SO IP CAN BE EXTERNAL
         */
        container.afterResolution("GameController", (_t, result: GameController) => 
        {
            // We want to replace the original method logic with something different
            result.getGameConfig = (sessionID: string) => 
            {
                return this.getGameConfig(sessionID);
            }
            // The modifier Always makes sure this replacement method is ALWAYS replaced
        }, {frequency: "Always"});


    }

    public generateNewLootForLocation(locationId:string, sessionID:string) {

        if(this.locationData[locationId] === undefined)
            this.locationData[locationId] = {};

        this.locationData[locationId].Data = this.locationController.get(locationId);
        
        const ownedCoopMatch = this.getCoopMatch(sessionID);
        if(ownedCoopMatch !== undefined) {
            ownedCoopMatch.Loot = this.locationData[locationId].Loot;
        }
        else {
            // console.warn(`Could not save Location Loot for match ${sessionID}. Unable to find Match.`);
        }
    }

    public getFriendsList(sessionID: string): IGetFriendListDataResponse
    {
        console.log("getFriendsList");
        const friends = this.getFriendsForUser(sessionID);

        return {
            "Friends": friends,
            "Ignore": [],
            "InIgnoreList": []
        };
    }

    public getFriendsForUser(sessionID: string): Friend[]
    {
        const allAccounts = this.saveServer.getProfiles();
		const myAccount = this.saveServer.getProfile(sessionID);
		if(myAccount === undefined) { 
			console.log("own account cannot be found");
			return null;
		}
        let friendList: Friend[] = [];
        // console.log(allAccounts);
        for (const id in allAccounts)
        {
            if(id == sessionID)
                continue;
            let accountProfile = this.saveServer.getProfile(id);
            let friend: Friend = {
                _id: accountProfile.info.id,
                Info: {
                    Level: accountProfile.characters.pmc.Info.Level,
                    Nickname: accountProfile.info.username,
                    Side: accountProfile.characters.pmc.Info.Side,
                    MemberCategory: MemberCategory.MemberCategory.DEFAULT
                }
            };
            friendList.push(friend);
        }

        return friendList;
    }

    public getGameConfig(sessionID: string): IGameConfigResponse
    {
        let externalIp = this.externalIPFinder.resolveExternalIP();

        const config: IGameConfigResponse = {
            languages: this.databaseServer.getTables().locales.languages,
            ndaFree: false,
            reportAvailable: false,
            twitchEventMember: false,
            lang: "en",
            aid: sessionID,
            taxonomy: 6,
            activeProfileId: `pmc${sessionID}`,
            backend: {
                Lobby: externalIp,
                Trading: externalIp,
                Messaging: externalIp,
                Main: externalIp,
                RagFair: externalIp,
            },
            utc_time: new Date().getTime() / 1000,
            totalInGame: 1
        };

        return config;
    }


    /**
     * This replaces Aki's Http Handler with a much better one that can asyncronously handle large POST requests without an error
     * @param sessionId 
     * @param req 
     * @param resp 
     * @param result 
     */
    public sitHttpHandler(sessionId: string, req: IncomingMessage, resp: ServerResponse, result: AkiHttpListener)
    {
        // TODO: cleanup into interface IVerbHandler
        switch (req.method)
        {
            case "GET":
            {
                const response = result.getResponse(sessionId, req, null);
                result.sendResponse(sessionId, req, resp, null, response);
                break;
            }
            case "POST":
            {
                req.on("data", async (data: any) =>
                {
                    if (sessionId === undefined)
                        sessionId = "launcher";

                    const requestLength = parseInt(req.headers["content-length"]);
                            
                    if (!this.httpBufferHandler.putInBuffer(sessionId, data, requestLength))
                    {
                        resp.writeContinue();
                    }
                });

                req.on("end", async () =>
                {
                    if (sessionId === undefined)
                        sessionId = "launcher";

                    const data = this.httpBufferHandler.getFromBuffer(sessionId);
                    const value = (req.headers["debug"] === "1") ? data.toString() : zlib.inflateSync(data);
                    if (req.headers["debug"] === "1") 
                    {
                        console.log(value.toString());
                    }
                    this.httpBufferHandler.resetBuffer(sessionId);
                    
                    const response = result.getResponse(sessionId, req, value);
                    result.sendResponse(sessionId, req, resp, value, response);
                });

                
                break;
            }
            case "PUT":
            {
                req.on("data", (data) =>
                {
                    // receive data
                    //if ("expect" in req.headers)
                    {
                        const requestLength = parseInt(req.headers["content-length"]);
                            
                        if (!this.httpBufferHandler.putInBuffer(req.headers.sessionid, data, requestLength))
                        {
                            resp.writeContinue();
                        }
                    }
                });
                    
                req.on("end", async () =>
                {
                    const data = this.httpBufferHandler.getFromBuffer(sessionId);
                    this.httpBufferHandler.resetBuffer(sessionId);
                    
                    let value = zlib.inflateSync(data);
                    if (!value)
                    {
                        value = data;
                    }
                    const response = result.getResponse(sessionId, req, value);
                    result.sendResponse(sessionId, req, resp, value, response);
                });
                break;
            }
            default:
            {
                break;
            }
        }


    
    }



    postDBLoad(container: tsyringe.DependencyContainer): void {
        StayInTarkovMod.container = container;

        const locations = StayInTarkovMod.container.resolve<DatabaseServer>("DatabaseServer").getTables().locations;

        // Open All Exfils. This is a SIT >mod< feature. Has nothing to do with the Coop module. Can be turned off in config/SITConfig.json
        if(this.sitConfig.openAllExfils === true) {
            console.log("Opening all Exfils");
            this.updateExtracts(locations);
        }

         // Initialize Custom Traders
         for(const t of this.traders) {
            t.postDBLoad(container);
        }
    }

    private updateExtracts(locations: any):void
    {
        // Initialize an array of all of the location names
        const locationNames = [
            "bigmap",
            "factory4_day",
            "factory4_night",
            "interchange",
            "laboratory",
            "lighthouse",
            "rezervbase",
            "shoreline",
            "tarkovstreets",
            "woods"
        ];
        
        // Loop through each location
        for (const location of locationNames)
        {
            // Loop through each extract
            for (const extract in locations[location].base.exits)
            {
                const extractName = locations[location].base.exits[extract].Name;

                // Make extracts available no matter what side of the map you spawned.
                const newEntryPoint = this.getEntryPoints(locations[location].base.Id);
                if (locations[location].base.exits[extract].EntryPoints !== newEntryPoint)
                {
                    locations[location].base.exits[extract].EntryPoints = newEntryPoint;
                }
                
                    
                // If this is a train extract... Move on to the next extract.
                if (locations[location].base.exits[extract].PassageRequirement === "Train")
                {
                    continue;
                }

                if (locations[location].base.exits[extract].PassageRequirement === "ScavCooperation")
                {
                    locations[location].base.exits[extract].PassageRequirement = "TransferItem";
                    locations[location].base.exits[extract].RequirementTip = "EXFIL_Item";
                }

                locations[location].base.exits[extract].ExfiltrationType = "Individual";
                locations[location].base.exits[extract].PlayersCount = 0;
            }
        }
    }

    private getEntryPoints(location:string):string
    {
        switch (location) {
            case "bigmap":
                return "Customs,Boiler Tanks";
            case "factory4_day":
                return "Factory";
            case "factory4_night":
                return "Factory";
            case "Interchange":
                return "MallSE,MallNW";
            case "laboratory":
                return "Common";
            case "Lighthouse":
                return "Tunnel,North";
            case "RezervBase":
                return "Common";
            case "Shoreline":
                return "Village,Riverside";
            case "TarkovStreets":
                return "E1_2,E6_1,E2_3,E3_4,E4_5,E5_6,E6_1"
            case "Woods":
                return "House,Old Station";
            default:
                return "";
        }
    }

}
module.exports = {mod: new StayInTarkovMod()}